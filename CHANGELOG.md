# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries describe what exists in the code;
anything not yet built is under "Known limitations" or not mentioned.

## [Unreleased] - encrypted publish (fixture-only, after 0.2.0)

**Still fixture-only. Do not use it on real notes.** Publishing is now encrypted, but the encryption is not
independently reviewed to the standard real notes need and has never been run inside Obsidian. `publish` and `init`
accept only a vault whose `.ipfs-sync-fixture` file holds the text `fixture`. That marker is an accident guard, not a
control: anyone who can create the file can override the refusal. Pulling an encrypted vault is not implemented, so
nothing published by this tree can be pulled back by it. Change: `mvp-06-encrypted-vault-publish`. Nothing here is
tagged or released.

### Added

- Client-side encryption of every publish, in the CLI and the plugin. File contents (AES-256-GCM, 8 MiB segments,
  a fresh key per file version), file names (HMAC-SHA256 node names in two-character prefix folders) and the manifest
  (`manifest.enc`, plus one encrypted history copy per publish under `manifests/`) are encrypted on the device. A
  random 256-bit vault key is wrapped by an Argon2id key (64 MiB, 3 iterations, 1 lane by default; floors 19,456 KiB and
  2 iterations; ceilings 131,072 KiB and 4) and stored in the public `keyslots.json` with a key commitment that is
  checked before decryption. The byte formats are in `DESIGN.md` section 8.
- `ipfs-sync abandon <vault> [--yes-abandon] [--mfs-root <path>]` and the plugin command "Abandon this vault" (also a
  button in the settings tab's Encryption section). They move this device's key-slot copy, sync state and journal for
  the MFS root into `.ipfs-sync/abandoned-<h>-<ms>/`. They never contact the node and delete nothing. They record the
  `encrypted-seen.json` latch before moving anything, so abandoning does not re-open the plaintext reader for that
  destination. The CLI takes the cross-process publish lock while it moves files; the plugin takes only its in-process
  lock. The CLI asks you
  to type `abandon` on a terminal and does nothing without one unless `--yes-abandon` is given. Refusal messages that
  name the abandon action now quote the command (`src/sync/abandon-hint.ts`).
- `ipfs-sync init <vault> [--passphrase-file <path>]`: the only way to create a vault. It generates the passphrase (23
  random symbols and 2 check symbols, shown in five groups of five). Interactively it shows the passphrase once and
  requires it to be typed again; with `--passphrase-file` it writes a new 0600 file, exclusively, and prints only the
  path. It ignores a passphrase in the environment and refuses a root that has any entry.
- Passphrase sources for `publish`: `IPFS_SYNC_PASSPHRASE_FILE` (0600, owned by you, not a symbolic link),
  `IPFS_SYNC_PASSPHRASE`, or a prompt that does not echo. Setting both variables is an error; there is no
  `--passphrase` flag; a `passphrase` key in a configuration file is rejected. The text is checked for the generated
  form before any request.
- Per-root local state in `<vault>/.ipfs-sync/` (`state.<h>.json`, `journal.<h>.json`, `keyslots.<h>.json`), a
  cross-process `publish.lock` with a 60-second heartbeat, and a copy of `keyslots.json` per MFS root that makes a wrong
  passphrase fail locally (`publish` still sends two read-only requests, `files/stat` and `key/list`, before it unlocks) and lets the tool refuse a substituted slot file before any derivation.
- Interrupted publishes: a journal is written before `manifest.enc`; the next run finishes, adopts or discards it.
  `publish --repair` continues past a behind, ahead, torn-manifest or unreadable-record refusal under stated
  conditions; `--recover-slots` unlocks slots a device knows nothing about after showing their cost;
  `--break-lock` removes the publish lock after a confirmation; `--allow-full-reupload` permits a non-interactive
  re-upload above 256 MiB.
- Plugin: "Clear stale publish lock" (command, and a "Publish lock" section in the settings tab). It is enabled only
  when the lock's last heartbeat is at least 15 minutes old. Clearing holds the plugin's sync lock for its whole
  duration (operation kind `clear-stale-lock`), so it refuses as busy while a publish, pull or abandon runs; it re-reads
  the age and token, moves the file aside, checks the moved bytes and puts the file back if it is not the lock that was
  seen. It does not stop a CLI publish on the same folder. A crash between the move-aside and the discard can leave a
  `.taken` file (a few bytes) in `.ipfs-sync/` that is never cleaned up automatically. A lock file that cannot be parsed
  is not clearable from the plugin; use `ipfs-sync publish --break-lock` on a computer.
- Read-back before publishing: the snapshot is read through its immutable path and checked before `pin/add` and
  `name/publish`, which use exactly the verified root CID.
- A history check before any write: a warning at 1,500 files in `manifests/` and a refusal at 1,999.
- A keyless idle path: an unchanged vault with a record, no journal and a matching root CID returns before unlocking, so
  the plugin's timer does not derive the key on every tick.
- Plugin: setup dialog (generated passphrase, re-entry, no-recovery acknowledgement), unlock dialog with a
  local probable-typo check, an in-memory session, an Encryption section in the settings tab (state and a Lock button),
  and an unlocking indicator that asks you to keep the app in the foreground. The timer never opens a dialog.
- Pull: detects an encrypted root and stops with "pulling encrypted vaults is not supported yet"; latches that fact in
  `.ipfs-sync/` so a later plaintext manifest for the same destination is refused as a possible downgrade. An
  `abandoned-<h>-<ms>` backup folder also counts as latch evidence: in the CLI, and in the plugin since a correction made
  after review 5c (the plugin's folder key-value store now lists matching folders); the plugin part is covered by
  fake-adapter tests only and has not run in Obsidian.
- Feature-operation script (`tools/feature-op-mvp-06.mjs`, `tools/feature-op-mvp-06/`): records the IPNS pointer of
  `obsidian-vault-sync` before the first change, prints and records the sha256 of `dist/cli/ipfs-sync.mjs` and whether it
  changed during the run, and refuses `--allow-stale-build` on the shared-node path. The lead reported a local stub run
  (121 of 121 checks) and tamper runs; I did not run them. It then ran twice against the shared node on 2026-09-30
  (task 6.2 and the delivery-cadence feature checkpoint; both exit 0, 121 of 121 checks; encrypted layout; publish #2 "1 written, 0 removed" at sequence 2; three kill points
  resumed; refusals sent no mutating request; the hostile-object variants ran against a local stub only; all 42
  mutating requests stayed under `/obsidian-vault-sync/mvp06-demo/<runid>` and the own key; Argon2id 844, 1096 and
  859 ms wall with a largest event-loop gap of 39 ms on the development machine). Consequences: the two runs left two run
  folders (`muo58t8n-ed2e9a64` and `muo6r3gr-8907bcc4`) and their pins on the node, and repointed the IPNS key
  `obsidian-vault-sync`: from the mvp-05 plaintext demo root `/ipfs/bafybeihh4slp53ygsfk454pm4tqjbccd5tu6s6egu37gai2mvfnbw6aa7e` to the first run's root
  `/ipfs/bafybeiec4bfadcs3iaowvg4yiwh66ivnrn3sym4r6h4x4xtw262un5jxwu`, and then to the second run's root
  `/ipfs/bafybeifu652yt23rpx4d4wgzd4rvyehf6xob6m53dzy6rntni2osl6oz3u` (current). Other keys are unchanged. Delivered behaviour differs from the task wording in two places: `--repair` on an older genuine manifest
  (behind) succeeds without a prompt (only ahead and rebuild ask), and the wrong-passphrase refusal sends two
  read-only requests, not none.
- Marker values: `fixture` (you, or `pnpm fixture:generate`) and `pulled-fixture` (written by pull).

### Changed

- **Publish is encrypted only.** Plaintext manifest v1 publishing is removed from the CLI and the plugin. `publish`
  needs the vault passphrase and refuses without one, before any request.
- **New MFS layout:** `current/<xx>/<52-character name>`, `manifests/<rootCID>.enc`, `manifest.enc`, `keyslots.json`. A
  root that holds a plaintext publication from an earlier release is refused; use a new MFS root. The old plaintext
  stays public and pinned.
- **Markers.** `publish` and `init` accept only `fixture`. A marker written by pull now reads `pulled-fixture` and
  `publish` refuses it. A pulled marker written by release 0.2.0 (`fixture copy created by ipfs-sync pull`, empty, or
  `marker`) is refused by `pull` with a message that says the marker predates this version and must be re-marked deliberately.
  `publish` uses that wording only for the pulled-copy text; an empty marker or `marker` gets its generic refusal. It must be re-marked deliberately by writing `fixture` (or, for pull, `pulled-fixture`) into
  `.ipfs-sync-fixture`. The fixture generator writes `fixture`.
- **Pull reads plaintext roots only with `--allow-plaintext-v1`**, never for a destination that has seen an encrypted
  vault, and refuses every manifest path under `.obsidian/` (previously only `.obsidian/plugins/`). The plugin has no
  setting for the flag, so its Pull cannot read a plaintext root.
- The pull demo of release 0.2.0 (publish a fixture vault, pull it into a second vault) no longer works with this tree.
- Local state format 1 (`state.json`, the pull record) is not used by publish; per-root files of format 2 replace it.
- **Release note, CLI host bridge.** Vault writes through `cli/node-host-bridge.ts` now create directories with mode
  0700 and files with mode 0600, via a temporary file. A crash can leave `.<name>.<pid>.<uuid>.tmp` inside a vault
  directory; delete such a file by hand if you find one.
- The plugin's `publish.lock` is created by a check and then a rename (two steps). `createExclusive`
  (`src/plugin/adapter-lock-file.ts`) reads the file back after the rename and compares the bytes, and removes its own
  file if the read-back throws; `src/plugin/lock-token-check.ts` checks the token a second time right after acquisition
  and before the publish starts. There is no check immediately before each write to the node, so a CLI publish and a
  plugin publish can overlap for up to one heartbeat interval (about 60 s) on a platform where rename overwrites. The
  plugin still depends on rename semantics for that window; what `adapter.rename` does in Obsidian is unconfirmed.

### Removed

- Plaintext manifest v1 publishing, in the CLI and in the plugin's Publish command.

### Security

- Anyone with the root CID can fetch the public key slot and guess the passphrase offline, permanently. Passphrases are
  generated (115 random bits plus a 10-bit check) for that reason. A leaked passphrase plus any old slot copy opens every
  state ever published: old roots stay pinned and this project never unpins. Changing the passphrase (not yet
  implemented) would not revoke either.
- The passphrase check catches a mistyped body symbol with probability about 99.9% and a mistyped check symbol always.
  About 1 in 1,024 arbitrary 25-symbol strings passes by chance. Generation-only is a typo guard, not proof that the
  user did not choose the text.
- There is no recovery for a lost passphrase.
- The environment variable, terminal scrollback of the interactive `init` display, and `script` and `tmux` logs can
  expose the passphrase; environment variables are inherited by child processes. The passphrase-file check cannot be made
  on Windows, and Node has no `openat`, so a swap of the file's parent directory between check and open can still misplace
  the file.
- The publisher pins whatever is in `current/` at snapshot time unless its read-back catches it, and does not re-verify
  blobs it did not write in a run.
- `.ipfs-sync/` (state, journal) is plaintext at rest and must be excluded from third-party sync and backups; deleting it
  resets the local state, including the encrypted-seen latch, and leaves the device unable to publish to roots it
  published to before. `abandon` does not reset the latch.

### Known limitations

- Fixture vaults only. Encryption is implemented but not independently reviewed to a standard that permits real notes
  and has never been run inside Obsidian. Reviews 0.1, 0.2, 2, 2b, 3, 3b, 4-1, 5, 5b (delta check of the split
  feature-operation script) and 5c are done; each was a static read by one model, and the cross-model judge was not run.
  Review 5 re-read the review 4-1 fixes (C-01 to C-08) statically. Review 5c re-read the review-5 fixes R5-01 to R5-08
  the same way, with nothing executed. The corrections made for its findings (C5-01, C5-03, C5-04, C5-05) have not been
  re-read by a reviewer, and C5-02 is open (below). There is no in-app run, no run with a real vault, and no Argon2id
  timing on a phone. The feature-operation script ran twice against the shared node (see "Added"); kubo `files/write`
  overwrite semantics beyond what it exercised, and whether kubo reads `arg` from a POST body, remain unverified.
- Terminal restore of the passphrase prompt is shown only in tests with injected streams (Ctrl-C, Ctrl-D, a 257th byte,
  end of input, a failure to enter raw mode). Restore on `SIGTERM`, `SIGHUP` and `SIGTSTP` is unverified.
- Deferred to `mvp-07`: W-14, W-15, W-16 and `prune-history` are preconditions for removing the fixture guard. The
  release tooling does not yet call `checkDistBundles` (N2-13); that blocks Release 2.
- Pulling an encrypted vault, changing the passphrase, adding key slots, and `ipfs-sync prune-history` do not exist yet.
  At 1,999 history files publishing to that root stops; the way on is a new MFS root and a new vault.
- The plugin cannot repair or recover slots; use the CLI. It can clear a publish lock that is at least 15 minutes stale,
  but not one it cannot parse. `--break-lock` deletes a live lock if run while a plugin publish is running. The setup,
  unlock, abandon and clear-stale-lock dialogs have never been run inside Obsidian. After an abandon, a second Publish
  can open a second unlock dialog over the first; this is cosmetic and accepted.
- Open (C5-02): the plugin's lock token is not re-checked immediately before each node write; only the heartbeat
  (every 60 s) notices a replaced lock file. See "Changed" above.
- The pull notice for a vault with other files now says "no files outside .obsidian/ and .ipfs-sync/"; it previously
  named only `.obsidian/`.
- Obsidian's `requestUrl` buffers whole response bodies, so the size caps give no memory protection inside the plugin.
- A restore that preserves file modification times and sizes is missed by the delta and idle paths.
- Rollback and freeze by an open-write node are not detected.
- Two devices publishing to one root are not supported.

## [0.2.0] - 2026-09-30 (fixture-only pre-release, plaintext)

**Release 1 is fixture-only. It must not be used on real notes.** It has no encryption. It syncs
synthetic fixture vaults only (a vault marked by a `.ipfs-sync-fixture` file), refuses any other vault,
and everything it publishes to your kubo node is readable by anyone who obtains the CID.

Tagged `v0.2.0` and published as a GitHub pre-release. The in-Obsidian demonstration that defines the release (a pull
with a real conflict in Obsidian desktop on macOS) is not recorded in this repository.

### Added

Increment mvp-01, configuration, auth, shared client, CLI:
- `ipfs-sync status`: node identity, MFS listing, gateway fetch, write probe and key state.
- Separate RPC (write) and gateway (read) endpoints, each with URL and optional port. Auth schemes: none,
  basic, bearer (static token or JWT), custom header. Flags override `IPFS_SYNC_*` environment variables,
  which override the config file; the config file rejects secrets.
- Node-safety checks: MFS root confined to `/obsidian-vault-sync`, publication key name pattern
  (`^obsidian-vault(-[a-z0-9-]+)?$`), and the fixture-vault guard.
- One shared kubo client (`src/kubo`) used by the plugin and the CLI. It works around the node's quirks:
  arguments in the query string, `files/write` as multipart with field `data`, `name/resolve` with
  `nocache=true`.

Increment mvp-02, manifest and delta publish:
- Manifest v1 with per-file sha256 and an `excludesHash`; change detection by size/mtime pre-filter, then sha256.
- `ipfs-sync publish <vault>`: sends only changed files to `<mfsRoot>/current/`, verifies each write,
  pins the MFS root, stores `manifest.json` and `manifests/<cid>.json`, and publishes the root CID to the IPNS key.
- Project-owned IPNS key `obsidian-vault-sync`, created only when absent and recorded under `ownedKeys`.
  A foreign key is refused unless its ID is passed with `--owned-key`.
- One shared exclusion list. Defaults: `.trash/`, `.ipfs-sync/`, `.ipfs-sync-fixture`, `.DS_Store`,
  `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, `.obsidian/workspace.json.bak`,
  `.obsidian/graph.json`, `.obsidian/cache`, `.obsidian/plugins/` (whole folder, so plugin code and
  plugin data stay on the device), `.obsidian/plugins/ipfs-sync/data.json`, `node_modules/`, `.git/`.
- Synthetic fixture vault generator: `pnpm fixture:generate <dir> [--seed <n>]`.

Increment mvp-03, delta pull and conflict policy:
- `ipfs-sync pull <vault>`: resolves the IPNS name, reads the manifest through the gateway, and fetches only
  missing or changed files. Each file is hashed against the manifest and renamed into place only on a match.
  Options `--name`, `--manifest <cid>` (restore an earlier snapshot) and `--manifest-file <path>`.
- Conflict policy: remote becomes canonical; a local file that differs from both the last synced state and the
  remote is kept as `name (ipfs conflict YYYY-MM-DD).ext`. Pull never deletes local files; remote deletions are reported only.
- Pull path policy: manifest paths that are absolute, contain `..` or empty segments, backslashes or control
  characters, lie inside `.ipfs-sync/` or `.obsidian/plugins/`, or match the exclusion list are refused and
  counted as failed. The CLI also refuses to write through a symbolic link.
- CLI destination guard: pull writes only into an absent, empty or marked directory.

Increment mvp-04, plugin publish and settings:
- **IPFS Sync: Publish vault** command, ribbon icon and status notice, on the same publish engine as the CLI.
  Publish requires the fixture marker.
- Settings tab: RPC and gateway URL and port, publication key, MFS root, auth scheme with per-scheme fields,
  exclusion list editor, owned-key display and adopt-by-ID with a confirmation dialog, optional auto-publish interval.
- Settings migration from the old flat settings; the old default key name `obsidian-vault` maps to `obsidian-vault-sync`,
  and an existing foreign key is never adopted implicitly.
- Node requests go through Obsidian's `requestUrl`, because the node's CORS rules block the WebView's `fetch`.

Increment mvp-05, plugin pull and conflict:
- **IPFS Sync: Pull vault** command and a Pull ribbon icon, with progress in a notice and the status bar and a
  summary of fetched, unchanged, conflict, failed and remote-deletion counts. It names up to three conflict copies and says
  "incomplete" when any file failed. Pull is read-only against the node.
- Same pull engine as the CLI: same verification, atomic writes, conflict copies and path policy.
- Pull target: the **pull name** setting (an IPNS key ID; `/ipns/` prefix accepted), else the ID of the owned
  publication key, else the pull stops and tells you to set a pull name.
- Destination guard for the plugin: Pull writes only into a vault that has the fixture marker or no files outside
  `.obsidian/` and `.ipfs-sync/` (the marker is then created). Any other vault is refused before any request.
- Every open editor is saved before files are compared, so an edit that exists only in the editor is treated as a local edit.
- Publish and Pull do not run at the same time in one vault.
- **Catch up on load** setting (per device, off by default): one pull after the workspace layout is ready.
- **Read cap** setting: default 64 MB per file, 8 to 1024. A file above the cap fails by name; other files continue.
- Settings show the last pull and last publish (counts, CIDs, timestamps only).
- Settings model moved to version 3, migrating from version 2 without changing existing values.

### Changed

- Build tooling is pnpm (`pnpm build`, `pnpm dev`, `pnpm test`, `pnpm typecheck`); `package-lock.json` is gone. Node 24.15 or later.
- `pnpm build` writes the plugin to `dist/plugin/` and the CLI to `dist/cli/ipfs-sync.mjs`; it does not write into a vault.
  `pnpm dev` writes into a vault only when `OBSIDIAN_PLUGIN_DIR` is set.
- Default publication key is `obsidian-vault-sync`, default MFS root `/obsidian-vault-sync/default`.
- The plugin's own `data.json` (which holds credentials) was added to the default exclusions, which changes the `excludesHash`.
- The `kubo-rpc-client` dependency was replaced by a small fetch-based caller behind the same client interface.
- Minimum Obsidian version is 1.12.3.
- The project is MIT licensed (copyright KnowMe AI, LLC).

### Removed

- `scripts/publish.sh`, `scripts/pull.sh` and `scripts/excludes.txt`. Use `ipfs-sync publish` and `ipfs-sync pull`.
- The plugin's old whole-archive pull and its `ipfsRequest()` helper.

### Known limitations

- No encryption. Fixture vaults only; other vaults are refused. Everything published is readable by anyone with the CID.
- The plugin cannot detect symbolic links: Obsidian's file adapter has no `lstat`. Do not place symlinks in a synced vault.
- Per-file read cap (64 MB by default, 8 to 1024 MB configurable); files are read whole, so large files cost memory.
- Remote deletions are not applied on pull; they are reported and the local file stays.
- Plugin writes replace an existing file by removing it and then renaming a temporary file, which is not atomic.
  A crash in that window could leave the file missing until the next pull. Untested.
- Mobile is not verified. Windows and Linux are not verified. The demonstration target is Obsidian desktop on macOS, and it has not been recorded yet.
- An authenticated (auth-protected) kubo endpoint has not been exercised with the plugin.
- Requires Obsidian 1.12.3 or later.
- Snapshot sync only: no multi-writer merge, no history browser, no AI layer.

## [0.1.0]

Version in `manifest.json` before this work. Not documented in detail here.
