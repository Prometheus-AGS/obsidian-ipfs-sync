# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries describe what exists in the code;
anything not yet built is under "Known limitations" or not mentioned.

## [Unreleased] - key management, history pruning, mass-removal guard, plaintext removal (fixture-only, after the pull below)

**Still fixture-only. Do not use it on real notes.** This section is change `mvp-07b-keys-history-guard-release-2`, the
code tasks only (`tasks.md` 1.x to 4.5, 4.8 and the added 2.3 and 2.4). It is covered by automated tests with fake nodes.
It has not been run inside Obsidian, on a phone, or by the operator against the shared node, and it has not been
independently reviewed. Not built: the operator-run script `tools/feature-op-mvp-07.mjs` (4.6, 4.7a, 4.7b), the
guard-removal branch (6.2), coalescing of auto-publishes (not built; the operator chose the CLI command plus a plugin prune
action in 1.8) and the check of the TTL a remote resolver sees after the restore form (4.9; the shared-node test of the
explicit options is recorded, see Changed). The plugin prune action (2.5) is built and covered by fake-DOM and wiring tests
only. Nothing here is tagged or released, and no release can pass the checker today.

### Added

- **`ipfs-sync keys change-passphrase`, `keys increase-cost`.** Replace the key slot by one that wraps the same vault key
  (a new generated passphrase, or the same passphrase at a higher cost; `--cost standard|high`). The new `keyslots.json`
  holds only the new slot. Nothing is re-encrypted; `manifest.enc` and the sequence do not change. Four derivations, a
  test unlock of the published file, then the local copy. A lower cost needs a confirmation that shows both costs.
  Rewrap does not revoke the old passphrase or any old copy of the key slot; the command says so before it asks.
- **`keys accept-slots`, `keys discard`.** Accept another device's changed slots from one root after the manifest of that
  root authenticates under the unlocked key (`--root-cid` with `--allow-rollback` for a restore across a rewrap), and drop
  a stuck key-management operation.
- **Maintenance journal** `maintenance.<h>.json` for rewrap and prune, separate from the publish journal. Publish and pull
  refuse while one exists and name `keys discard` and `keys accept-slots`. A rewrap that loses the name race puts back
  the old key-slot file; after a rewrap or prune the next publish with no change reports nothing changed.
- **`ipfs-sync prune-history <vault> --keep <n> [--dry-run | --yes-prune]`.** Removes the oldest history files from the
  node's working tree, keeps at least the newest 20, checks the newest 20 and the node's sequence first, republishes under
  the same sequence. The 1,500 and 1,999 messages name it.
- **Mass-removal guard.** `publish` stops when the removals that count equal every remaining entry or exceed half of at
  least two (exactly half proceeds). Exclusion-driven removals are listed apart and not counted; carried entries count as
  kept. `--allow-mass-removal`, a CLI yes, or a plugin dialog on a manual publish confirm; the timer refuses.
- **Plugin:** Encryption-section rows for change passphrase, increase cost, accept key slots and the slot's cost; dialogs
  for each, for the mass-removal confirmation and for a key slot above the default cost (manual pull, Resolve fork,
  Restore, manual publish at the unlock and the key actions ask; the timer and catch-up pull do not); and the command
  "Measure key derivation time" (one Argon2id derivation at the default cost on random input, with the longest event-loop
  gap and the first 16 characters of the `main.js` hash).
- **Desktop Range streaming.** On desktop a GET with a `Range` header goes through Node `http` and `https` (found with
  `globalThis.require`) and is cancelled after the header bytes. Mobile still buffers whole bodies.
- **Guard evidence tooling:** `tools/check-guard-preconditions.mjs` (tree hash, clean-export build, review record,
  operator-run record, phone timing, dist and checklist tests), `tools/record-phone-timing.mjs`, `tools/release-mvp-07.mjs`
  and per-release descriptors in `tools/release/`. Fixture policy is centralised in `src/sync/fixture-constants.ts`,
  `publish-guard.ts`, `pull-guard.ts` and `state-folder-guard.ts` with no behaviour change.

### Removed

- **The plaintext reader.** `--allow-plaintext-v1` and `--manifest-file` are unknown options; the v1 manifest, pull, plan,
  fetch, record, target, screen and latch modules are deleted. A root with `manifest.json` and no key slots is refused
  ("plaintext publications are no longer supported by this version"). `abandon` records no latch and prints the sequence
  floor. `encrypted-seen.json` is no longer written or read. This supersedes the 07a line that kept the plaintext reader
  behind a flag.

### Changed

- A vault emptied on a device that has a state no longer publishes an empty manifest: the mass-removal guard stops it.
  The empty-vault error remains for a first publish.
- `abandon` also moves a pending `maintenance.<h>.json`.
- Restore step for the IPNS pointer after a shared-node run: the printed form and the runbook are now
  `ipfs name publish --key=<key> --ttl 5m <pointer>` (the lifetime stays at kubo's 24h default). On 2026-10-04 kubo v0.42.0
  on the shared node accepted `--ttl 5m --lifetime 24h` on a throwaway key and the pointer resolved. The TTL a remote
  resolver sees was not checked.

### Security and limits

- Silent per-file corruption of unchanged files by someone who can write to the node is not detected by the publisher.
- Removing 49 percent of the entries is silent.
- Concurrent publishes are narrowed, not prevented.
- The sequence floor does not stop a node from showing an old copy to a device that has no recorded state.
- Rewrap does not revoke the old passphrase or any old copy of the key slot.
- The review record, the operator-run record and the phone-timing record are attestations, not proofs.
- A change to any scoped file after the review record or after the operator run changes the tree hash, and both must be redone.
- Two wrong code texts found while writing these notes are fixed: the cost statement and `keys increase-cost` help now say
  that the CLI without a terminal and the plugin's timer and catch-up pull refuse a cost above the default while manual
  plugin actions ask in a dialog, and the maintenance-pending message now says the ways out are command-line commands.
  What remains true: the plugin has no `keys discard` and does not finish an interrupted operation (Accept changed key
  slots also clears a pending operation). The history-growth decision (task 1.8) is taken: the CLI command and a plugin
  prune action both exist; coalescing is not built.
- **Plugin prune action (task 2.5).** A "Prune history..." row in the Encryption section, hidden until a vault exists. The
  dialog asks for a keep count (the floor of 20 is shown; a smaller number is raised) and the current passphrase, then
  does a dry run under one key derivation and shows counts only (removed, kept, total) with the engine's own statements.
  The review step focuses Cancel; files are removed only on an explicit press of the remove control, never on Cancel,
  Escape or closing the window. It takes the same lock pair as the other key actions, and the 2.4 cost confirmation
  applies. The auto-publish timer and the catch-up pull never prune. There is no resume in the plugin: an interrupted
  prune is finished with `ipfs-sync prune-history`, and the plugin has no discard action. The 1,500 warning and the 1,999
  refusal now name the command and the Encryption-section action. Tested with a fake DOM and stubs; not run in Obsidian
  or on a phone, and not tried with a screen reader.
- **History growth under auto-publish (task 1.8).** A timer at 15 minutes on a vault that changes on every tick writes 96
  history files a day: the warning at about 15.6 days, the refusal at about 20.8 days. The timer default is off. Auto-publish
  does not coalesce; the recovery is pruning, from the CLI or the plugin.
- On a High-cost vault the auto-publish timer stays refused until a manual unlock; a wrong-passphrase pull asks the cost
  question again on every attempt; the desktop streaming lookup is unconfirmed inside Obsidian.

## [Unreleased] - encrypted pull and second-device publish (fixture-only, after the encrypted publish below)

**Still fixture-only. Do not use it on real notes.** This section is change `mvp-07-encrypted-pull-second-device`, task
group `07a`: the read side of the encrypted vault. It is covered by automated tests with fake nodes. It has not been run
inside Obsidian, on a phone, or by the operator against the shared node, and it has not been independently reviewed. The
`publish` and `init` guard (`.ipfs-sync-fixture` must hold `fixture`) is unchanged and is removed in `mvp-07b`. Nothing
here is tagged or released. The v0.2.0 pre-release is still the plaintext build and does not contain any of this.

### Added

- **`ipfs-sync pull` reads an encrypted vault.** It takes the vault passphrase (same sources as `publish`) and
  `publish.lock`, reads only (`name/resolve`, `key/list`, listings, gateway reads), authenticates `manifest.enc` before
  it requests any file, plans each path on plaintext sha256 (this device, the baseline, the node), fetches from the
  immutable tree the authenticated manifest names (never the mutable `current/`), decrypts into `.ipfs-sync/tmp/`,
  renames a file into place only when its size and sha256 equal the manifest entry, and writes the state file last.
  Flags: `--name`, `--root-cid`, `--manifest`, `--allow-rollback`, `--resolve-fork`, `--expect-min-sequence`,
  `--expect-vault-id`, `--accept-first-pull`, `--max-bytes` (default 536870912, 512 MiB), `--accept-large` and
  `--list-versions` (the newest 20 history entries by name, with date and device for files of at most 8 MiB). The output
  lists `integrity-failed`, `unfetched` and skipped paths apart. Exit 0: everything written and verified, or skipped as
  expected. Exit 1: a file failed or was not fetched, a path was skipped as unsafe, or the pull stopped at a check.
  Exit 2: a refused invocation or destination.
- **The record and the sequence floor.** This device records the highest manifest sequence it accepted, in
  `state.<h>.json` (now format 3: adds `manifestIdentity`, `previousIdentity`, `highestSequence`, `highestIdentity`,
  `complete`, `unmaterialized`, `devicesSeen` and `restoredFrom`; format 2, which no released build wrote, is upgraded on
  read) and in `sequence-floor.json` outside the vault (CLI: a per-user directory; plugin: the `deviceStore` section of
  the plugin data). A node that serves a lower sequence is refused. The floor survives `abandon`, deleting `.ipfs-sync/`
  and a changed MFS root. It keeps at most 64 vaults.
- **First pull** shows the sequence, date and device the vault key holder chose and asks (or needs
  `--accept-first-pull`). A declined first pull writes no file, marker, state, floor or key-slot copy; the lock may leave
  an empty `.ipfs-sync/` folder.
- **Restore** (`--allow-rollback` with `--root-cid` or `--manifest`; plugin: "Restore an older version") adds and replaces
  files, never deletes, keeps local edits as dated conflict copies and does not lower the recorded sequence; the next
  publish makes the result a new version.
- **Fork resolution** (`--resolve-fork`, needs a terminal; plugin: "Resolve fork") merges against the common ancestor in
  the node's history. With no ancestor, every file that differs from the node's becomes a conflict copy.
- **Second-device publish.** A second device pulls, adopts the owned key (`ownedKeys` in the config file, or
  `--owned-key <id>` for one run; plugin: "Adopt a key by ID") and publishes at the next sequence. The publisher reads the
  publication name before its first write and again before `name/publish` and refuses when it moved ("another device may
  have published"). The drift guard removes stray blobs only when no other device was ever seen.
- **History names carry the sequence:** `manifests/<16-digit sequence>-<rootCID>.enc`. Names written by a `mvp-06`
  development build (`<rootCID>.enc`) still read and sort first.
- **Path policy for pulled manifests:** paths a pull must not write are skipped before any request, as `expected` (the
  configuration folder, the exclusion list) or `unsafe` (a shape no honest publisher produces, or a name another platform
  can write: Windows forms, reserved names, 8.3 shapes, case-fold collisions). The policy is host-independent: a name such
  as `CON.md` is refused by pull on every host including Linux, is carried unchanged in that device's publishes, and
  makes the pull exit 1. The publisher warns about such names and never refuses.
- **Plugin:** Pull for encrypted vaults (first-pull, restore, fork and large-pull dialogs; the catch-up pull never opens
  a dialog), the commands "Restore an older version" and "Resolve fork", a "Pull record" row in the Encryption section,
  and the setting "Ask before pulling more than (MB)" (`pullConfirmAboveMb`, 64 to 8192, default 512). The plugin sweeps
  `.ipfs-sync/tmp/` on load only while it holds `publish.lock`.
- The publish engine awaits a fresh lock-token check (`beforeFirstWrite`) right before its first request that can change
  the node, in the CLI and the plugin.

### Changed

- **`.obsidian/` no longer syncs.** The default exclusion list now holds the whole `.obsidian/` folder in place of the
  narrower entries, and `.smart-env/`. The default list's `excludesHash` is now
  `ebd10cbd1cd9776229910af44cc1455550e840ba6aad25e8ba9434b0df32da0f` (before this change:
  `062286b651a2f5a832e1b8913d4e4fcd7dcfd39c081d5eb0bf5f5310962ddc9d`). A pull of a manifest with another hash prints one
  warning and verifies every local file by content. Entries of an old manifest under `.obsidian/` are skipped as expected
  (exit 0) and leave the manifest at the next publish.
- **`.smart-env/` (Smart Connections embeddings) is excluded by default.** Reason, limited to what a desk study read in
  that plugin's source and issues (nothing was installed or run): the plugin queues a re-import 13 seconds after a note
  edit and appends to files in that folder; its README tells third-party sync users to ignore it; its author advised
  against syncing the embedding files. On our side, the idle check (path, size and modification time must all equal the
  record) cannot apply while those files change, and each non-empty publish adds one history file toward the warning at
  1,500 and the refusal at 1,999.
- **`publish --repair` in the "node is ahead" case** is refused ("Run pull first, then publish again.") when a floor
  exists for the vault, when the local state decodes, and for a device with no state and no floor. It remains only for a
  state file that exists, does not decode, and has no floor, behind its confirmation. The "ahead" and fork refusals of
  `publish` now name `pull` and `pull --resolve-fork`; the new-device refusal names `pull`.
- A directory that `pull` populated carries `pulled-fixture`; to publish from it, write `fixture` into
  `.ipfs-sync-fixture` by hand (your statement that it holds no real notes; nothing verifies it).
- `pull` routes by the root: key slots or an encrypted manifest mean the decrypting reader. The plaintext (version 1)
  reader stays behind `--allow-plaintext-v1`, and the encrypted-only flags are refused on a plaintext root.
- The token check moved from `src/plugin/lock-token-check.ts` to `src/sync/lock-token-check.ts` and is shared by the CLI
  and the plugin.

### Security

- A pull detects a replayed older genuine manifest only on a device that already accepted a newer one. A first pull has no
  baseline and trusts what the node serves; a freeze (withheld updates) is not detected. Deleting the per-user directory
  (CLI), the plugin data or reinstalling the plugin removes the floor.
- Someone who holds the vault key can publish a manifest with a very high sequence; every device that pulls it records it
  and then refuses honest, lower manifests. Recovery: delete the floor file and the affected `state.<h>.json` files and
  pull again as a first pull (the floor file holds every vault's floor).
- `--root-cid` and `--manifest` name what the gateway serves; the client does not verify the returned bytes against the
  CID, so authenticity rests on the vault key.
- `.ipfs-sync/tmp/` holds verified plaintext until a file is renamed or swept. A file whose size and modification time equal
  the recorded values is not hashed, so a pull can replace an in-place edit that kept both without a conflict copy.
- On the operator's node an unresolvable name always answers `could not resolve name`, identically for a never-published
  name and for `dht-timeout` of 1 ms, 1 s and 10 s. The publisher's name re-check can therefore detect a move only when
  the name resolves; a routing failure on a vault that already has a published name reads as `not-found` and the publish
  proceeds. It is not a compare-and-swap, and a write race on the shared MFS tree is not detected.

### Known limitations

- Fixture vaults only; nothing here ran inside Obsidian, on a phone, or by the operator against the shared node
  (`mvp-07b`). The plugin dialogs for pull were never opened in Obsidian.
- Large-file pull in the plugin is not advertised as working until the `mvp-07b` operator run records the outcome. The
  CLI streams; the plugin holds up to a 128 MiB budget (a design budget, not a measurement), its transport buffers whole
  responses, and a gateway that ignores Range makes files above 32 MiB `unfetched`.
- Plugin `rename` onto an existing file removes the target first, so it is not atomic.
- A key slot above the default Argon2id cost has no confirmation dialog in the plugin (superseded by the 07b cost dialog above, for manual actions only).
- Paths this device could not restore stay as the node has them in the baseline; the next publish carries them unchanged
  and publishes nothing from this device for them.
- Measured on an iPhone (iOS 27.2 beta, Obsidian 1.13.7 build 365; operator screenshots and reports of 2026-10-02, not
  reproduced by an agent): the release 0.2.0 plaintext pull worked for 5 files (24 KB) and for a 50 MB and a 5 MB random
  file; Argon2id at 64 MiB, t = 3, p = 1 took 980, 1143 and 1133 ms with a longest event-loop gap of 21, 17 and 17 ms in a
  probe build (`0.2.1-probe.1`). The first pull crashed the app once (unexplained); the relaunch loop was an iOS
  file-provider hang cleared by restarting the phone. The encrypted pull has not run on a phone; Android is untested.
  Phone test installs go through BRAT from a GitHub pre-release with its own tag, fixture-only until the guard is removed.

## [Unreleased] - encrypted publish (fixture-only, after 0.2.0)

**Still fixture-only. Do not use it on real notes.** Publishing is now encrypted, but the encryption is not
independently reviewed to the standard real notes need and has never been run inside Obsidian. `publish` and `init`
accept only a vault whose `.ipfs-sync-fixture` file holds the text `fixture`. That marker is an accident guard, not a
control: anyone who can create the file can override the refusal. This section describes change
`mvp-06-encrypted-vault-publish` as it stood when it was written; where the section above differs (pull of an encrypted
vault, state format 3, history names with a sequence prefix, the exclusion list, `--repair` in the ahead case), the section
above is current. Nothing here is tagged or released.

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
- Pull (as of `mvp-06`; the section above supersedes this refusal): detected an encrypted root and stopped with "pulling
  encrypted vaults is not supported yet"; latches that fact in
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
  file if the read-back throws; the token check (then `src/plugin/lock-token-check.ts`, now `src/sync/lock-token-check.ts`) checks the token a second time right after acquisition
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
  re-read by a reviewer, and C5-02 is open (below). There is no in-app run and no run with a real vault; Argon2id was
  timed on an iPhone in a probe build after this entry was written (see the section above). The feature-operation script ran twice against the shared node (see "Added"); kubo `files/write`
  overwrite semantics beyond what it exercised, and whether kubo reads `arg` from a POST body, remain unverified.
- Terminal restore of the passphrase prompt is shown only in tests with injected streams (Ctrl-C, Ctrl-D, a 257th byte,
  end of input, a failure to enter raw mode). Restore on `SIGTERM`, `SIGHUP` and `SIGTSTP` is unverified.
- Deferred to `mvp-07b`: W-14, W-15, W-16 and `prune-history` are preconditions for removing the fixture guard. The
  release tooling does not yet call `checkDistBundles` (N2-13); that blocks Release 2.
- Changing the passphrase, adding key slots, and `ipfs-sync prune-history` do not exist yet (pulling an encrypted vault
  does now; see the section above). At 1,999 history files publishing to that root stops; the way on is a new MFS root
  and a new vault.
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
