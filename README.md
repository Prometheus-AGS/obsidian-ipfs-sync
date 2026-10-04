# IPFS Sync for Obsidian

Sync your vault over IPFS through your own kubo node (`https://ipfs.prometheusags.ai`).
No Obsidian Sync subscription. No third-party cloud. Content-addressed snapshots now,
CRDT multi-writer sync and an AI layer later.

> **Fixture-only pre-release. Do not use it on real notes.**
>
> - **What the tree does now.** Every publish is encrypted on your device: file contents, file names and the
>   manifest. The key comes from a passphrase the tool generates for you. Encryption is implemented, but it has not
>   been independently reviewed to the standard real notes need, and it has never been run inside Obsidian. Until that
>   changes, the CLI and the plugin publish only synthetic fixture vaults (a `.ipfs-sync-fixture` file in the vault
>   root that holds the text `fixture`) and refuse every other vault. That marker is an accident guard, not a
>   control: anyone who can create the file can override the refusal.
> - **Pulling an encrypted vault is implemented in this tree and has not been run by the operator.** `ipfs-sync pull` and the
>   plugin's Pull, Restore and Resolve fork read an encrypted vault back, check it against the highest sequence this
>   device recorded, and write only verified files. The code is covered by automated tests with fake nodes. It has not
>   been run inside Obsidian, on a phone, or against the shared node by the operator (that run belongs to `mvp-07b`).
>   Large-file pull in the plugin is not advertised as working until that run records the outcome.
> - **Key management, history pruning and the removal guard (`mvp-07b`, code only, unreleased).** The command line has
>   `keys change-passphrase`, `keys increase-cost`, `keys accept-slots`, `keys discard` and `prune-history`. Publish
>   stops a mass removal. The plaintext reader is gone. The plugin has dialogs for the key actions, the removal
>   confirmation and the cost confirmation, and a command that times key derivation. This is covered by automated tests
>   with fake nodes. None of it has been run inside Obsidian, on a phone or against the shared node by the operator,
>   and the operator-run script for it (`tools/feature-op-mvp-07.mjs`) is not written yet. It has not been reviewed
>   independently. The marker guard above is still in this tree.
> - **Release 0.2.0** (tagged `v0.2.0`, a GitHub pre-release) is the plaintext build: it has no encryption, and
>   everything it published is readable by anyone who obtains the CID. The encryption described below is not in 0.2.0;
>   it is unreleased work after it. This tree cannot read what 0.2.0 published: a plaintext root is refused.
> - The release demonstration targets Obsidian desktop on macOS. It is not recorded in this repository, so nothing is
>   verified on any platform yet. Mobile, Windows and Linux are not verified either.

## What's here (Phase 1)

| Piece | Where | What it does |
|---|---|---|
| Obsidian plugin | `src/main.ts` → `dist/plugin/` (`main.js`, `manifest.json`) | Publish (encrypted), Pull, Restore an older version, Resolve fork, Status and Measure key derivation time commands, settings tab with an Encryption section (Pull record row, key-derivation cost, change passphrase, increase cost, accept key slots), dialogs for mass removal and for a key slot above the default cost, optional auto-publish. Fixture vaults only |
| CLI init | `ipfs-sync init` | The only way to create an encrypted vault: generates the passphrase and the key slots |
| CLI publish | `ipfs-sync publish` | Encrypt and send only changed files to the node's MFS, then publish the snapshot to the IPNS key |
| CLI pull | `ipfs-sync pull` | Reads an encrypted vault back: authenticates the manifest, checks the sequence against this device's record, writes only verified files. Also restores an older version, resolves a fork and lists versions. A plaintext (version 1) root from release 0.2.0 is refused |
| CLI keys | `ipfs-sync keys change-passphrase`, `increase-cost`, `accept-slots`, `discard` | Replace the key slot under a new generated passphrase or a higher cost, accept another device's change, drop a stuck operation. Revokes nothing (see "Change the passphrase or the cost") |
| CLI prune | `ipfs-sync prune-history` | Remove the oldest history files from the node's working tree so the folder stays under the publisher's limit (see "History growth") |
| Exclusions | `src/sync/exclusions.ts` | Shared exclusion list: trash, the whole `.obsidian/` folder, the Smart Connections folder `.smart-env/`, this dev folder and the fixture marker file. Plugin code and plugin data are device-local and are never published or pulled |

**Mutable pointer:** the project IPNS key `obsidian-vault-sync` on your node. `publish`
creates it if absent and records its ID in the config file (`ownedKeys`). Each publish
points the key at the CID of the MFS root, which holds `current/` (encrypted files under opaque names in
two-character prefix folders), `manifests/` (one encrypted history copy of the manifest per publish, named
`<16-digit sequence>-<rootCID>.enc`; a development build wrote `<rootCID>.enc`, which still reads), `manifest.enc` and
`keyslots.json`.
Swap for DNSLink (`_dnslink.ipfs.prometheusags.ai` → `/ipfs/<cid>`) whenever you
want a human-readable name — same content, one DNS record.

**Conflict policy (pull, CLI and plugin; both run the same engine):** pull never deletes and never loses
data. Each file is compared on plaintext sha256 three ways: this device's file, the baseline of the last pull or
publish, and the node's. A file this device did not edit is replaced; a file only this device edited stays; where both
changed (or there is no baseline), the node's version takes the path and the local content is preserved as
`name (ipfs conflict YYYY-MM-DD).ext` (the extension is kept so the copy opens in the same app). Pull leaves files that
are remotely deleted in place and reports them; remote deletions are not applied.
Pull also refuses manifest paths it must not write: absolute paths, `..` segments, backslashes, control characters,
anything inside `.ipfs-sync/`, anything under `.obsidian/`, anything on the exclusion list, and names another platform can
write that this one cannot take safely, on every host including Linux (Windows reserved names such as `CON.md`, trailing dots and spaces, 8.3 short names, case-fold
collisions). A path under `.obsidian/` or on the exclusion list is skipped as expected and does not change the exit code;
any other refused path is skipped as unsafe and makes the CLI exit 1. The rest of the pull continues.
True merging arrives with the Phase 2 op-log. See "Pull" below.

## Obsidian plugin

**Fixture-only.** The plugin encrypts every publish. It publishes only in a vault that contains the
`.ipfs-sync-fixture` marker holding the text `fixture`. Any other vault is refused before a single request is sent,
with a notice. Pull works in a vault that contains the marker (either `fixture` or `pulled-fixture`), or that has no
files outside `.obsidian/` and `.ipfs-sync/` (Pull then creates the marker with the text `pulled-fixture`, which
Publish refuses). Do not install this on a vault that holds real notes.

`pnpm build` writes the plugin to `dist/plugin/` (`main.js` and `manifest.json`) and the CLI
to `dist/cli/ipfs-sync.mjs`. A build never writes into a vault by default. To load the plugin
in Obsidian, copy the two files from `dist/plugin/` into `<vault>/.obsidian/plugins/ipfs-sync/`,
then enable **IPFS Sync** under `Settings → Community Plugins`.

Dev loop: `pnpm install && pnpm dev` watches and rebuilds. `pnpm dev` writes the plugin to
`dist/plugin/` unless the `OBSIDIAN_PLUGIN_DIR` environment variable is set; then it writes
`main.js` and `manifest.json` into that directory, for example
`OBSIDIAN_PLUGIN_DIR=<vault>/.obsidian/plugins/ipfs-sync pnpm dev`. `pnpm build` ignores
the variable. Warning: `OBSIDIAN_PLUGIN_DIR` overwrites the plugin files in that directory on
every rebuild. Do not point it at a vault you do not want to overwrite.

Requires Obsidian 1.12.3 or later (`minAppVersion`). The release demonstration targets Obsidian desktop on macOS; it is not recorded here.
`isDesktopOnly` is false in the manifest, but mobile has not been run.

What the plugin does today:

- Commands (`Ctrl/Cmd+P`): **IPFS Sync: Publish vault**, **IPFS Sync: Pull vault**,
  **IPFS Sync: Restore an older version**, **IPFS Sync: Resolve fork** and **IPFS Sync: Show status**. Two ribbon icons
  run Publish and Pull. An optional auto-publish interval (minutes, 0 = off) is set in the settings tab.
- **Publish is encrypted and needs the vault passphrase.** On a device with no vault, Publish opens the setup dialog;
  only its **Create vault** button creates one. The dialog shows the generated passphrase once, in five groups of
  five, asks you to save it in a password manager and type it again, and states that a lost passphrase means the data
  is lost for good. You tick an acknowledgement before Create is enabled. There is no field for choosing your own
  passphrase. On a device with a vault, the first Publish of a session opens the unlock dialog; a passphrase whose
  check symbols do not match is reported as a probable typo without contacting the node. The unlocked key is held in
  memory only (never in `data.json`) until you press **Lock now** in the settings tab's Encryption section or the
  plugin unloads. Deriving the key takes seconds and 64 MiB of memory; the dialog asks you to keep the app in the
  foreground.
- The auto-publish timer never opens a dialog. While the vault is locked it skips the publish and shows one notice per
  session. While it is unlocked, a tick on an unchanged vault does not derive the key again.
- **The plugin cannot repair.** `--repair`, `--recover-slots` and `--break-lock` exist only in the command line tool. The plugin can clear a publish lock that is at least 15 minutes stale ("Clear stale publish lock"). It has no row or command for `keys discard`, and it cannot finish an interrupted key action or prune; use the command line for those. (It does have a "Prune history..." row; see "History growth" below.)
- **Key management in the Encryption section** (mvp-07b, never run in Obsidian). Three rows open dialogs: **Change the passphrase**, **Increase the key-derivation cost** and **Accept changed key slots**. Each states before its confirm button works that the old passphrase and every old copy of the key-slot file keep opening the vault. The change-passphrase dialog shows the generated passphrase once, in five groups of five, and asks you to type it again; there is no field for your own. There is no clipboard control. A lower cost needs its own tick and shows both costs. After a change the dialog shows the result of a test unlock. Another device must run Accept changed key slots (or `ipfs-sync keys accept-slots`) with the new passphrase before it can pull or publish again. A row shows the cost of this device's key slot.
- **Prune history in the Encryption section** (mvp-07b task 2.5, never run in Obsidian). A fourth row, hidden until a vault exists, opens a dialog: a keep count (the floor of 20 is shown), the current passphrase, then a dry-run preview that shows counts only. Cancel has the focus in the review step, and files are removed only when you press the remove control. It takes the same locks as the key actions, and the cost confirmation below applies. The timer and the catch-up pull never prune. The plugin has no resume and no discard; `ipfs-sync prune-history` finishes an interrupted prune.
- **Cost confirmation.** A key slot above the default cost (64 MiB, 3 iterations), such as the High preset (128 MiB, 4), makes the plugin ask through a dialog that shows the cost; Cancel is the default. It asks on a manual Pull, Resolve fork, Restore, manual Publish (at the unlock) and the key actions. The auto-publish timer and the catch-up pull never ask: while the vault is locked they keep refusing a High-cost vault until you unlock it by hand. A wrong passphrase on a pull asks the cost question again on each attempt. A phone may not be able to unlock High; that was not measured.
- **A mass removal stops a manual publish** with a dialog (counts only; Cancel is the default). The timer never opens it: it shows a notice and writes nothing. See "Publishing".
- **Measure key derivation time** (command) runs one Argon2id derivation at the default cost on random input, with no vault data and no passphrase, and shows the seconds, the platform, whether it completed, the longest event-loop gap and the first 16 characters of the installed `main.js` hash in groups of four (or "unavailable"). Keep the app open while it runs.
  When a publish is refused and the message names one of them, run `ipfs-sync publish` for that vault.
- Pull reads only: name resolve, key list, listings and gateway reads. It changes nothing on the node. It saves
  every open editor first, so an edit that exists only in an editor counts as a local edit. It uses the unlocked
  key when the session holds one; otherwise it asks for the passphrase (an unattended catch-up pull refuses instead of
  asking). A first pull of a vault opens a dialog that shows the sequence, date and device the vault key holder chose
  and states that nothing can confirm them; Cancel writes nothing. Progress and the result show as a notice and in the
  status bar. The result names the fetched, unchanged, conflict, failed and remote-deletion counts and up to three
  conflict copies, and says when files are unfinished. The plugin has no setting that lets it read a plaintext root.
- **Restore an older version** lists the newest 20 history names, reads the date and device of entries of at most 8 MiB,
  loads and authenticates the entry you choose, and shows that entry's own sequence and date before you confirm. It adds
  and replaces files, never deletes, keeps local edits as conflict copies, and does not lower the recorded highest
  sequence; your next publish makes the result a new version. **Resolve fork** asks first; where this device and the node
  differ, the node's version takes the file and this device's text is kept as a dated conflict copy. A pull that stops at
  a fork shows a notice with a Resolve fork button. Both need a pull name that is an IPNS name.
- The Encryption section of the settings tab shows a **Pull record** row: the highest sequence recorded for this vault,
  whether the last pull was complete, how many files are unfinished, and the sequence a restore took.
- Pull target: the **pull name** setting (an IPNS key ID; a `/ipns/` prefix is accepted, and `/ipfs/<cid>` pulls one
  explicit root). When it is empty the plugin uses the ID of the publication key, but only if that key exists on the node
  and is recorded as owned. Otherwise Pull stops before fetching and tells you to set a pull name. **Ask before pulling
  more than (MB)** (64 to 8192, default 512) is the size above which a pull asks first; if you decline, nothing is
  fetched.
- Publish and Pull do not run at the same time in one vault; the second request is ignored with a notice.
- **Catch-up on load** (setting, off by default, per device): one pull after the workspace layout is ready.
  It obeys the same guards as a manual pull, does not delay startup, and shows a notice only when it
  changed files, made a conflict copy, or failed.
- **Read cap** (setting): the largest single file the plugin will read into memory, default 64 MB,
  whole numbers from 8 to 1024. Obsidian's file adapter has no partial read, so a file is loaded whole. A file
  above the cap is counted as failed, named in the result, and the other files continue.
- Settings tab: RPC and gateway endpoints (URL plus optional port each), publication key name,
  MFS root, authentication scheme (none, basic, bearer, custom header), the exclusion list, the
  owned IPNS keys, and the pull name, catch-up and read cap settings above, an Encryption section (state: not set up,
  locked or unlocked; Lock, Set up and Unlock buttons), plus the last pull and last publish summaries
  (counts, CIDs and timestamps only, no file names or secrets).
- Node requests go through Obsidian's `requestUrl`, not `fetch`, because the node's CORS
  rules block the WebView (quirk 4 below).
- The whole `.obsidian/` folder is never published and never pulled (before `mvp-07a` only `.obsidian/plugins/` was):
  plugin code and plugin data, including this plugin's own `data.json` with your credentials, stay on the device. Those
  credentials are stored in plain text, and so is the sequence floor, which lives in the same plugin data.

### Pull

`ipfs-sync pull <vault>` (and the plugin's Pull) does this, in order: refuse invalid flag combinations; check the
destination (absent, empty, or marked `fixture` or `pulled-fixture`); take `publish.lock`; resolve the name and list the
root; unlock (the local key-slot copy first, so a wrong passphrase is refused locally); authenticate `manifest.enc`; decide
the verdict against this device's record; on a first pull, show the sequence, date and device and ask; plan each path;
fetch each file from the immutable tree the authenticated manifest names (never the mutable `current/`), decrypt it into
`.ipfs-sync/tmp/` and rename it into place only when its size and sha256 equal the manifest entry; write the state file
last. A pull that dies earlier leaves whole, verified files and the old state.

- **Flags** (all in `--help`): `--name`, `--root-cid`, `--manifest`, `--allow-rollback`, `--resolve-fork`,
  `--expect-min-sequence`, `--expect-vault-id`, `--accept-first-pull`, `--max-bytes`, `--accept-large`,
  `--list-versions`. `--allow-plaintext-v1` and `--manifest-file` are gone and are rejected as unknown options.
- **The record and the floor.** This device records the highest manifest sequence it accepted, in
  `.ipfs-sync/state.<h>.json` and in a sequence floor outside the vault (CLI: `sequence-floor.json` in a per-user
  directory; plugin: the `deviceStore` section of the plugin data). A node that serves a lower sequence than the record
  is refused, unless you restore on purpose with `--allow-rollback` and `--root-cid` or `--manifest`. **Limits:** deleting
  the per-user directory or the plugin data, or reinstalling the plugin, removes the floor; a first pull has no baseline
  and trusts what the node serves; a freeze (withheld updates) is not detected; and someone who holds the vault key can
  publish a very high sequence that every device then records. The recovery is to delete the floor file and the affected
  `state.<h>.json` files and pull again as a first pull.
- **First pull.** It shows the sequence, date and device, which whoever holds the vault key chose, and needs a yes (or
  `--accept-first-pull`). Declining writes no file, marker, state, floor or key-slot copy (the CLI's lock may leave an empty
  `.ipfs-sync/` folder). A root CID given with
  `--root-cid` is only as trustworthy as the gateway that serves it: the client does not check the returned bytes against
  the CID, so authenticity rests on the vault key.
- **Restore adds and replaces; it never deletes** a file that exists only in later versions. The recorded highest
  sequence stays, and the next publish makes the result a new version.
- **Fork resolution.** Two devices that publish the same sequence with different content make a fork; `--resolve-fork`
  (needs a terminal) merges against the common ancestor in the node's history, keeping files only this device changed and
  giving a file both changed a dated conflict copy with the node's text on the path. **With no ancestor** (this device
  has no record of the manifest it built on, because it last pulled or its state predates the record; the history lacks
  the entry; or none or several entries match) every file that differs from the node's becomes a conflict copy.
- **Concurrent publishes are narrowed, not prevented.** A publish reads the name before its first write and again before
  `name/publish`, and refuses if it moved. kubo has no compare-and-swap. The drift guard protects another device's blobs
  only after this device has pulled a manifest of that device. A routing timeout on a vault's first publish counts as
  "not found".
- **Files this device could not restore** (`integrity-failed` or `unfetched`) make the pull exit 1. The next publish
  keeps the node's entry for such a path unchanged and publishes nothing from this device for it.
- **Second device.** Same MFS root and publication key name as the first, the owned key adopted (its ID in `ownedKeys`
  in the config file, or `--owned-key <id>` for one run; in the plugin, "Adopt a key by ID"), and a pull before the first
  publish. A directory that pull populated carries the marker `pulled-fixture`, which `publish` refuses; write `fixture`
  into `.ipfs-sync-fixture` by hand to publish from it (your statement that it holds no real notes; nothing verifies it).
- **`.obsidian/` no longer syncs, and the default exclusion list changed.** `excludesHash` is now
  `ebd10cbd1cd9776229910af44cc1455550e840ba6aad25e8ba9434b0df32da0f`; before this change it was `062286b6...ddc9d`. A pull
  of a manifest with another hash prints one warning and verifies every local file by content. Entries of an older
  manifest under `.obsidian/` are skipped as expected (exit 0) and leave the manifest at your next publish.
- **`.smart-env/` is excluded by default.** It is the embeddings folder of the Smart Connections plugin. A desk study that
  read that plugin's source and issues (nothing was installed or run) found: it queues a re-import 13 seconds after a
  note edit and appends to files in that folder; its README tells third-party sync users to ignore `.smart-env/`; its
  author advised against syncing the embedding files. On our side, the idle check (path, size and modification time must
  all equal the record) cannot apply while those files change, and each non-empty publish adds one history file toward
  the warning at 1,500 and the refusal at 1,999. Nothing here claims more about Smart Connections than that.
- **Temporary files are plaintext at rest** in `.ipfs-sync/tmp/` until renamed or swept. A file with the same size and
  modification time as recorded is not hashed, so an in-place edit that keeps both can be replaced by a pull without a
  conflict copy. In the plugin, `rename` onto an existing file removes the target first, so it is not atomic.
- **Plugin memory.** The CLI streams blobs. The plugin holds up to a 128 MiB budget (a design budget, not a measurement)
  and its transport buffers whole responses; a gateway that ignores the Range header makes large files `unfetched`.
  Large-file pull in the plugin is not advertised as working until the `mvp-07b` operator run records the outcome.
- **Phones.** The exact plugin build reaches a phone through BRAT from a GitHub pre-release that carries the reviewed
  bytes and has its own tag, never the main tag. Do not use an iCloud vault or a manual iCloud copy: a manual copy hung
  the app at "Loading plugins" and a file-provider hang cleared only by restarting the phone. `.obsidian/plugins/` is not
  synced by this tool. Android is untested and is not claimed. Until the guard is removed (`mvp-07b`) it is a
  fixture-only build. What was measured on an iPhone is in "Not
  verified".

The earlier "pull demo" (publish a fixture vault, then pull it into a second vault) is implemented in this tree for
encrypted fixture vaults (see "Encrypted vaults"); it has not been run by the operator. **There is no plaintext reader.**
A root that holds `manifest.json` and no key slots (what release 0.2.0 published) is refused with "plaintext
publications are no longer supported by this version" (CLI exit 2, nothing written), whatever this device has seen
before. A root with key slots and no `manifest.enc` is refused too, and a planted `manifest.json` next to an encrypted
layout is never read. The `encrypted-seen.json` latch that used to stop a downgrade is gone; the sequence floor is the
only record that a vault was ever accepted, and it covers encrypted manifests only. A downgrade cannot happen because no
code path reads a plaintext manifest.

### Plugin limitations

- Encryption is implemented but not independently reviewed and not verified in Obsidian; fixture vaults only (above).
- The plugin cannot detect symbolic links, because Obsidian's file adapter has no `lstat`. The CLI refuses to
  write through a symlink; the plugin cannot make that check. Do not place symlinks in a vault you sync.
- **Desktop streams ranged reads; mobile still buffers.** On desktop the plugin sends a GET that carries a `Range`
  header through Node's `http` and `https`, found with `globalThis.require`, and cancels after the header bytes, so a
  hostile gateway cannot make it buffer a multi-GB body for a 22-byte header read. Whether `globalThis.require` exists
  inside real Obsidian is unconfirmed; if it does not, the plugin falls back to buffering without saying so. On mobile
  and for every other request, Obsidian's `requestUrl` buffers each whole response body in memory. Redirects are not
  followed on the streaming path and it has no timeout.
- Obsidian's `requestUrl` transport buffers each whole response body in memory. The one-segment memory bound and the
  size caps that protect the CLI give no protection for what `requestUrl` has already buffered, and Range requests
  reduce the exposure only against gateways that honour them. The plugin pull holds up to a 128 MiB budget (a design
  budget, not a measurement); a gateway that ignores Range makes files above 32 MiB `unfetched`, and so does a blob with
  segments below 1 MiB. Multi-megabyte binary bodies through `requestUrl` are unverified, and large-file pull in the
  plugin is not advertised as working until the `mvp-07b` operator run records the outcome.
- Writes go through a temporary file in `.ipfs-sync/tmp/` and then a rename. Where the destination already exists,
  the plugin removes it first and then renames, so `rename` is not atomic and a crash in between can leave the file
  missing until the next pull. This window has not been tested. The temporary files hold verified plaintext until they are
  renamed or swept (on plugin load, only while it holds `publish.lock`).
- A local file above the read cap cannot be compared with the node's; the pull reports it as unfetched and leaves it.
- The catch-up pull never opens a dialog: a locked vault or a first pull makes it refuse, and so does a key slot above
  the default Argon2id cost (manual actions ask through the cost dialog; see "Obsidian plugin"). Restore and Resolve fork need a pull
  name that is an IPNS name, not an explicit `/ipfs/<cid>` root.
- The plugin's publish lock file (`.ipfs-sync/publish.lock`) is best effort. It is created by a check and then a rename
  (two steps), read back after the rename and compared (`src/plugin/adapter-lock-file.ts`), and checked once more right
  after acquisition and before the publish starts (`src/sync/lock-token-check.ts`, shared with the CLI). Since `mvp-07a`
  the engine also awaits a fresh check right before its first request that can change the node (resume, key creation or
  first blob, junk removal). There is no check immediately before each write to the node, so a CLI publish and a plugin
  publish can overlap for up to one heartbeat interval (about 60 s) on a platform where rename overwrites. What `adapter.rename` does with an existing target in Obsidian is
  unconfirmed, and the plugin still depends on it for that window. If the plugin
  crashes while holding it, a CLI publish waits until the lock has had no heartbeat for 15 minutes, or you pass
  `--break-lock`. The plugin's "Clear stale publish lock" command (also a "Publish lock" section in the settings tab)
  clears a lock whose last heartbeat is at least 15 minutes old, holding the plugin's sync lock while it works (it
  refuses as busy during a publish, pull or abandon, and does not stop a CLI publish on the same folder). A crash
  between its move-aside and its discard can leave a `.taken` file in `.ipfs-sync/` (a few bytes) that nothing cleans
  up automatically; delete it by hand. A lock file it cannot parse is not clearable there, so
  use `--break-lock` on a computer. `--break-lock` deletes a live lock if it is run while a plugin publish is running.
- Remote deletions are reported, not applied. A file deleted on the publishing side stays on the receiving side.
- Per-file read cap (above). Large files cost whole-file memory.
- The setup, unlock, abandon, clear-stale-lock, first-pull, restore, fork, large-pull, change-passphrase,
  increase-cost, accept-key-slots, mass-removal and cost-confirm dialogs, and the measure command, have never been run
  inside Obsidian. Their accessibility was checked with a fake DOM and source scans, not a screen reader; touch targets,
  contrast and keyboard overlap on a phone are unchecked. The abandon dialog opens from the
  "Abandon this vault" command and from a button in the settings tab's Encryption section; that wiring is covered only
  by tests with a fake host. After an abandon, a second Publish can open a second unlock dialog over the first; this is
  cosmetic and accepted.
- Mobile, Windows and Linux are not verified. On an iPhone, only the release 0.2.0 plaintext pull and an Argon2id timing
  were run (see "Not verified"); the encrypted flow was not.

## CLI usage

Requires Node >= 24.15 and pnpm. Build once, then run the CLI (or the `ipfs-sync` bin):

```bash
pnpm install && pnpm build

node dist/cli/ipfs-sync.mjs status
node dist/cli/ipfs-sync.mjs init <vault> [--passphrase-file <path>]
node dist/cli/ipfs-sync.mjs publish <vault> [--repair] [--recover-slots] [--break-lock] [--allow-full-reupload]
    [--allow-mass-removal]
node dist/cli/ipfs-sync.mjs pull <vault> [--name <ipns-id>] [--root-cid <cid> | --manifest <cid>]
    [--allow-rollback | --resolve-fork] [--expect-min-sequence <n>] [--expect-vault-id <id>]
    [--accept-first-pull] [--max-bytes <n>] [--accept-large]
node dist/cli/ipfs-sync.mjs pull <vault> --list-versions
node dist/cli/ipfs-sync.mjs keys change-passphrase <vault> [--cost standard|high] [--passphrase-file <path>]
    [--accept-no-revocation] [--allow-downgrade]
node dist/cli/ipfs-sync.mjs keys increase-cost <vault> --cost standard|high [--accept-no-revocation]
node dist/cli/ipfs-sync.mjs keys accept-slots <vault> [--name <id> | --root-cid <cid> [--allow-rollback]] [--allow-downgrade]
node dist/cli/ipfs-sync.mjs keys discard <vault> [--yes-discard]
node dist/cli/ipfs-sync.mjs prune-history <vault> --keep <n> [--dry-run | --yes-prune]
```

- `status` shows node identity, MFS listing, gateway fetch, write probe and key state.
- `init` creates the encrypted vault for `<vault>` (next section). `publish` never creates one.
- `publish` sends only changed files, always encrypted, and needs the vault passphrase. It accepts only a vault whose
  `.ipfs-sync-fixture` file holds the text `fixture`, and needs an MFS root strictly below `/obsidian-vault-sync`.
- `pull` fetches only files whose sha256 differs, from an encrypted root (see "Pull"), with the same passphrase sources as
  `publish`. `pull` without `--name` uses the ID of the owned `obsidian-vault-sync` key. `--manifest <cid>` or
  `--root-cid <cid>` with `--allow-rollback` restores an earlier version; `--list-versions` shows the newest 20 history
  entries; `--resolve-fork` merges after a fork. `--accept-first-pull` and `--accept-large` are the non-interactive yes
  to the first-pull and the large-pull questions; `--max-bytes` sets the ceiling (default 536870912, 512 MiB). Exit
  codes: 0 ok, 1 a file failed or was not fetched, a path was skipped as unsafe, or the pull stopped at a check, 2
  usage or a refused destination (a plaintext root is one). The `keys` commands and `prune-history` are described
  under "Change the passphrase or the cost" and "History growth"; every flag above is in `--help`.
- Endpoints and auth: `--rpc-url`, `--gateway-url`, `--mfs-root`, `--key`, `--config`,
  `--auth`, or the `IPFS_SYNC_*` environment variables (`IPFS_SYNC_RPC_URL`,
  `IPFS_SYNC_GATEWAY_URL`, `IPFS_SYNC_MFS_ROOT`, `IPFS_SYNC_KEY`, `IPFS_SYNC_AUTH_*`).
  Flags override environment, which overrides the config file. Run
  `node dist/cli/ipfs-sync.mjs --help` for the full list.

The CLI is a plain Node HTTP client against the kubo RPC and gateway — no local IPFS
daemon needed.

## Encrypted vaults

The details of every format and the threat model are in `DESIGN.md` section 8. The operator runbook (refusal
messages and what to do) is in `docs/operator/encrypted-vault.md`. What follows is what you need to run it.

### What is protected, and what is not

Files, paths and the manifest are encrypted (AES-256-GCM) under a random vault key. The vault key is stored on the node
wrapped by a key derived from your passphrase with Argon2id (64 MiB, 3 iterations by default). What the node, or anyone
who can write to it, can still see: the number of files, the exact size of each file, when you publish and how often,
which encrypted blobs change, and that the vault exists. It can delete, corrupt, replace or withhold any object, and it
can serve you an older valid snapshot. A pull refuses a sequence below the highest one this device recorded, which
catches a replay only on a device that has already accepted a newer one; it cannot catch a freeze or a stale first pull
(see "Pull"). Without the passphrase it cannot read
names, paths, contents or the manifest, and cannot make you encrypt under a different key.

Three consequences to accept before you use it:

- **The key slot is public.** Anyone who has the root CID can download `keyslots.json` and guess passphrases offline,
  forever, at the cost of Argon2id. That is why passphrases are generated: 23 random symbols (115 bits) plus 2 check
  symbols. A leaked passphrase, plus any copy of the slot (every old root stays pinned on the node and this project
  never unpins), opens every state you ever published.
- **A passphrase change revokes nothing.** Rewrap does not revoke the old passphrase or any old copy of the key slot.
  An old copy, including the ones in earlier pinned roots, keeps opening the same vault key. Only re-encrypting the
  vault under a new key revokes access, and nothing here does that.
- **There is no recovery.** If you lose the passphrase, and every copy of the key slots, the data is gone. Nobody can
  reset it. The copy of `keyslots.json` this tool keeps in `.ipfs-sync/` protects only against the node losing the file.

### Create a vault: `ipfs-sync init`

`ipfs-sync init <vault>` is the only command that creates a vault. It needs the vault to carry the `fixture` marker,
an MFS root strictly below `/obsidian-vault-sync` that is completely empty on the node (any entry at all is refused),
and no key-slot copy already on this device for that root. It generates the passphrase itself; a passphrase in the
environment is ignored, and you cannot choose one.

- **Interactive** (standard input and standard error are both terminals): it prints the passphrase once, in five
  groups of five, then asks you to type it again. Save it in a password manager first. What it printed stays in your
  terminal scrollback and in the logs of tools such as `script` and `tmux`; clear or disable those first, or use the
  file form.
- **Automated:** `ipfs-sync init <vault> --passphrase-file <path>` writes the passphrase to a new file (mode 0600,
  created exclusively) and prints only the path. It refuses an existing file, a symbolic link, and a directory that is a
  symbolic link, belongs to another user, or is writable by others without the sticky bit.
  The file holds the passphrase in five hyphenated groups and a line feed.

Then use the file for every later `publish`. Use a new MFS root for each vault (`--mfs-root
/obsidian-vault-sync/<name>`). A root that holds a plaintext publication from release 0.2.0 is refused, so pick a new
one; the old plaintext stays public and pinned on the node.

### Where the passphrase comes from

`publish` and `pull` read it from exactly one of:

1. the file named by `IPFS_SYNC_PASSPHRASE_FILE` (POSIX: mode 0600 or stricter, owned by you, a regular file, not a
   symbolic link);
2. the environment variable `IPFS_SYNC_PASSPHRASE`;
3. a prompt that does not echo, when standard input is a terminal and neither variable is set (256-byte limit;
   Ctrl-C and Ctrl-D abort). In tests with injected streams the terminal is restored after Ctrl-C, Ctrl-D, a 257th byte,
   end of input and a failure to enter raw mode. Restore on `SIGTERM`, `SIGHUP` and `SIGTSTP` is unverified.

Setting both variables is an error. There is no `--passphrase` flag, and a configuration file containing a `passphrase`
key is rejected. Whatever you supply is checked for the generated form (25 letters and digits A-Z and 2-7, hyphens and
spaces ignored, case ignored, valid check symbols) before any request is sent. With no source, `publish` fails before
any request.

Exposure you should know about:

- An environment variable stays readable by your other processes, is inherited by every child process started with it in
  the environment, can land in shell history and CI logs, and the runtime may keep copies of it. Prefer the prompt for
  interactive work and the 0600 file for automation.
- The interactive `init` display leaves the passphrase in terminal scrollback and in `script` and `tmux` logs.
- The CLI overwrites the passphrase bytes it holds after key derivation, on a best-effort basis. Strings cannot be
  overwritten, and the runtime may copy buffers. The plugin's dialog holds the passphrase in an interface string that
  cannot be zeroed.
- A non-extractable key object does not stop other code in the same application context (another plugin) from using
  it. Non-extractability protects only against exporting the base key.
- Node has no `openat`, so the passphrase file is opened by path. A writer who can swap the file's parent directory
  between the tool's check and its open can still cause the file to be misplaced. The read side opens with
  `O_NOFOLLOW` and checks the descriptor, and `init` compares device and inode after creating the file, which narrows
  the window and does not close it.
- Windows has no POSIX file modes. The mode check cannot be made there; the file inherits its folder's access list.
  `init` says so before it writes. Symbolic links are still refused where they can be detected.

### The passphrase is generated, and the check is a typo guard

The passphrase is 25 characters from `A-Z` and `2-7` (RFC 4648 base32): 23 random symbols and 2 check symbols. Letters
are not case-sensitive and hyphens are optional when you type it. The check symbols let the tool report a probable typo
without contacting the node. They catch a mistyped body symbol with probability about 99.9% and a mistyped check symbol
always; they do not catch every typo, and about 1 in 1,024 arbitrary 25-symbol strings passes the check by chance. So
requiring the generated form guards against typos and accidents. It does not prove that you did not choose or grind the
text. The alphabet is not free of look-alike characters (S and 5, Z and 2, G and 6, I and L); copy the passphrase
instead of retyping it from memory.

### Change the passphrase or the cost: `ipfs-sync keys`

Rewrap does not revoke the old passphrase or any old copy of the key slot. The commands below replace the key slot of an
existing vault by one that wraps the same vault key; nothing is re-encrypted, and `manifest.enc` and the sequence do not
change. The two rewrap commands print this before they work and ask (or need `--accept-no-revocation`; without a terminal
they do nothing unless the flag is given). They need the vault passphrase, hold `publish.lock` for the whole operation, and
refuse unless this device is up to date with the node and no publish or key-management operation is pending.
`accept-slots` and `discard` hold the lock too and skip the pending-operation refusal, so a stuck journal cannot block them.

- `keys change-passphrase <vault>` writes a slot under a NEW generated passphrase; you cannot choose one. It is shown once
  and retyped, or written to a new 0600 file with `--passphrase-file`. `--cost standard|high` sets the new slot's cost
  (Standard 64 MiB and 3 iterations, High 128 MiB and 4); without it the cost stays. A lower cost than the current one
  needs a yes that shows both costs, or `--allow-downgrade`.
- `keys increase-cost <vault> --cost standard|high` writes a slot under the SAME passphrase at a higher cost. It does not
  protect against an attacker who already holds the old, cheaper slot, because every earlier root keeps it.
- The new `keyslots.json` holds only the new slot. The old passphrase fails against the node's current file and still
  opens the copy in every earlier pinned root. A file with a slot type this version does not know is refused before any
  derivation.
- It takes four key derivations on this device (the current passphrase twice, the new slot, then a test unlock of the
  published file). The local copy and record change only after the test unlock passes. If another device's rewrap won the
  race, the test fails and says so.
- If the command is interrupted, publish and pull stay paused until you run the same command again; it finishes the
  operation without making a second slot. A lost race is refused with a message that names `keys discard` and
  `keys accept-slots`.
- A cost above the default (64 MiB, 3) makes every device that cannot answer a cost question refuse to unlock: a command
  line run without a terminal, and the plugin's timer and catch-up pull. Manual plugin actions ask (see "Obsidian
  plugin").
- `keys accept-slots <vault>` is for every other device after a rewrap: until it runs, that device refuses to pull or
  publish and the message names it. It resolves the name once (or reads `--root-cid`), reads `keyslots.json` and
  `manifest.enc` from that one root, unlocks the slot with the passphrase you give, requires the manifest of the same root
  to authenticate under that key and name the same vault, and applies the sequence checks of a pull. A cheaper slot than
  this device's copy shows both costs and needs a yes (or `--allow-downgrade`). It replaces only the key-slot copy, its
  recorded hash and a pending publish journal's hash. It pulls no file and does not raise the sequence floor; run `pull`
  afterwards. It drops an unfinished key-management operation on this device. **What it does not prove:** a node that also
  knows the passphrase you type could serve key slots and a manifest under its own key with this vault's id, and a command
  line run holds no key to compare them with.
- **Restore across a rewrap.** `pull --root-cid <old root>` reads that root's older `keyslots.json`, which differs from
  this device's copy, so it refuses and names `keys accept-slots --root-cid <old root> --allow-rollback`. After that
  accept the pull runs under the older passphrase, and publish and pull by name stay refused until you run
  `keys accept-slots` again, without `--root-cid`. `pull --manifest` and the plugin's Restore read a history entry under
  the current root and need no accept, on a device that already holds the current key-slot copy.
- `keys discard <vault>` drops a key-management operation (a rewrap or a prune) that did not finish, when running the same
  command again cannot finish it. It asks first (or needs `--yes-discard`). It touches the node only to take this device's
  own key-slot file back out of the shared tree when the rewrap never published. A rewrap that already published keeps the
  new slots on the node: discarding forgets that here, and this device then needs `keys accept-slots` with the NEW
  passphrase. Do not discard if you did not save the new passphrase.

### Publishing

```bash
IPFS_SYNC_PASSPHRASE_FILE=<path> node dist/cli/ipfs-sync.mjs publish <vault> --mfs-root /obsidian-vault-sync/<name>
```

`publish` unlocks from the copy of the key slots this device keeps, so a wrong passphrase is refused locally. Before it unlocks,
`publish` sends two read-only requests (`files/stat`, `key/list`), and no mutating request. It
then compares the node with its own record, sends only what changed (a changed file is re-encrypted and uploaded whole;
a rename is a delete plus a new upload, because the node name is bound into the encryption), reads the snapshot back
through its immutable path, and only then pins it and publishes the IPNS record. Any failure before the IPNS record leaves
it unchanged. It prints the root CID, the snapshot CID, the `sequence` number and `N written, M removed`; a run with no
changes writes nothing and does not touch the IPNS record.

**A mass removal stops the publish.** After the plan and before any write, `publish` counts the paths it would remove.
It stops, with a typed refusal and nothing written, when the removals that count equal every remaining entry of the
manifest, or exceed half of the remaining entries of a manifest that had at least two. Exactly half proceeds. Removals
caused by the exclusion list (a path the previous manifest held that the effective list now matches, such as the
`.obsidian/` entries of an older build on upgrade day) are listed apart and count in neither number; entries this device
carries unchanged because it could not restore them count as kept. The first publish of a vault has no baseline and is
not checked. Confirm with `--allow-mass-removal` or a yes at the prompt; without a terminal the run stops. In the plugin a
manual publish opens a dialog with counts only and Cancel as the default; the auto-publish timer never opens it, shows a
notice and writes nothing. The dialog opens while the publish locks are held; reasoned from the lock code and not run,
a dialog left open past 15 minutes lapses the lock heartbeat and the publish then refuses and writes nothing. This guard
replaces the old behaviour in which a vault emptied on a device that had a state published an empty manifest; the empty
vault error remains for a first publish. The message says an unmounted or emptied vault folder looks the same, because
it does. Limits are in "Limits that stay".

What `publish` does not verify: it pins whatever is in `current/` at the moment of the snapshot, including an object
someone planted during the write window, unless its read-back catches it. Blobs that a run did not write are not
re-checked on later runs, so a node writer can replace one quietly and only a reader that decrypts it will notice. A
dropped connection during a write can leave a truncated blob under the MFS root; the next publish diagnoses it and
rewrites only what differs.

A file whose size and modification time equal the recorded values is not read again. A restore that preserves the
modification time (`cp -p`, `rsync -t`, some backup tools) and gives a file of the same size is therefore missed by
the delta check and by the idle check that skips unlocking, until the size or the time changes.

### Interrupted publishes, `--repair`, `--recover-slots`, `--break-lock`

- **Journal.** Before it writes `manifest.enc`, a publish writes `.ipfs-sync/journal.<h>.json`. If the process dies,
  the next `publish` reads the node's manifest and either finishes the interrupted publish, adopts its state and
  publishes again at the next sequence, or discards the journal. The refusal messages never tell you to delete local
  state.
- **`--repair`** continues past a refusal that says the node is behind this device's record, the node is ahead of it, or
  a manifest or local record is unreadable after a torn write. It works only when the node's manifest authenticates with
  your key, belongs to this vault, and the node's `keyslots.json` equals this device's copy byte for byte. It publishes at
  one above the greater of the sequences it knows. **The "ahead" case changed in `mvp-07a`:** a node that is ahead means
  another device published, and the way forward is `pull`, so `--repair` refuses it ("Run pull first, then publish
  again.") when a sequence floor exists for the vault or this device has a state that decodes, and for a device with no
  state and no floor. It stays available only for a state file that exists and does not decode, with no floor; then it
  warns that changes made by any other publisher will be discarded and asks first. When `--repair` rewrites a missing or
  unreadable `manifest.enc` it warns that whatever the node held there cannot be recovered; that asks first too. The
  "behind" case (the node serves an older snapshot) does not ask. `--repair` is also the only way to have the tool
  remove stray entries from `manifests/` on the node, after a confirmation, one name at a time. A run that cannot ask
  (no terminal) declines.
- **`--recover-slots`** unlocks key slots this device knows nothing about: the node holds `keyslots.json` but no
  manifest, and this device has neither a record nor a copy. It shows the Argon2id cost and asks before it derives.
  Without it the tool refuses (use a new MFS root, or ask for recovery explicitly).
- **`--break-lock`** removes `.ipfs-sync/publish.lock` after a confirmation, then continues. A lock is replaced
  automatically when the recorded process is gone from this host, or when it has had no heartbeat for 15 minutes on any
  host. The lock is a best-effort guard, not an atomic lock across machines.
- **`--allow-full-reupload`** allows a non-interactive run to upload again more than 256 MiB of files the node no longer
  holds as recorded.
- A second device takes turns, it does not publish at the same time (see "Pull" for onboarding and for what concurrent
  publishes can do). A device with no record of a root that already holds a manifest is refused before any derivation
  ("this device is not the publisher") and told to run `pull`.
- If none of these apply, the way out is a new MFS root and a new vault (`init`). The refusal messages call this the
  "abandon action": run `ipfs-sync abandon <vault>` (add `--mfs-root` to name the root), or use the plugin command
  "Abandon this vault" (also a button in the Encryption section of the settings tab). It moves this device's key-slot
  copy, sync state, journal and any key-management journal for that root into `.ipfs-sync/abandoned-<h>-<ms>/`. It never
  contacts the node and deletes nothing. It records no latch (there is none any more) and prints the sequence floor it
  keeps. On a terminal you must type `abandon`; without one it does nothing unless you pass `--yes-abandon`.

### History growth

Every publish that changes something adds one file to `manifests/` on the node: an encrypted copy of the whole manifest,
about 4 to 14 MB for a vault of 5,000 to 20,000 files, pinned forever. The tool lists that folder before it writes
anything. It warns at 1,500 files and refuses at 1,999, with a message that names `ipfs-sync prune-history`.

`ipfs-sync prune-history <vault> --keep <n>` removes the oldest history files from the node's working tree so that `n`
remain. At least the newest 20 are kept whatever `n` says. Order comes from the sequence-prefixed names; older names
without a prefix count as the oldest, have no order among themselves, and the confirmation says so. Before it asks, it
checks that the newest history file authenticates under this vault's key, carries the sequence of the node's manifest
(a node that withholds the newest files is refused), and that each of the newest 20 decrypts and agrees with its name;
that this device is up to date; that no publish or key-management operation is pending; that `manifests/` holds only
history files and at most 2,000 of them; and it holds `publish.lock`. It prints how many go, how many stay, how many
carry the older name format and how many share a sequence (a fork leaves such files), then asks (or needs `--yes-prune`;
`--dry-run` prints the files and stops without a lock). It removes one file at a time under `manifests/` and nothing
else, then republishes the root under the same sequence with no new manifest. `current/`, `manifest.enc` and
`keyslots.json` do not change. Earlier published roots stay pinned and keep their history, but a removed version can no
longer be restored through the current root with `pull --manifest`; use `pull --root-cid` of an earlier root. A fork
resolution after a prune still finds its common ancestor, which is always among the newest 20. If it is interrupted,
publish and pull stay paused until you run it again; `keys discard` drops it. A folder already above 2,000 entries
cannot be listed, so it cannot be pruned by this command; the way out is a new MFS root.

**How a plugin-only vault stays under the limit (task 1.8, decided).** `prune-history` is the supported recovery, from the
command line and from a "Prune history..." row in the plugin's Encryption section. The plugin dialog shows counts only
and removes nothing until you press the remove control; the timer and the catch-up pull never prune; an interrupted prune
is finished with the command, because the plugin cannot resume. Auto-publish does not coalesce: that is not built. The arithmetic, for a
timer set to 15 minutes and a vault that changes on every tick: 96 history files a day, the warning in about 15.6 days,
the refusal in about 20.8 days. The shipped default timer is off, and `.smart-env/` and `.obsidian/` are already excluded;
another plugin that writes to a hidden folder can still cause this. The exclusion of `.smart-env/` removes one known
source of constant non-empty publishes (see "Pull"); it does not bound growth for other plugins that write often.

### Local state: `.ipfs-sync/`

`<vault>/.ipfs-sync/` holds, per MFS root, `state.<h>.json` (format 3), `journal.<h>.json` and `keyslots.<h>.json`, plus
`maintenance.<h>.json` (only while a rewrap or a prune is unfinished), `publish.lock` and `tmp/` (in-flight pull files)
(`<h>` is the first 16 hex characters of the SHA-256 of the MFS root). **The state and journal are plaintext at rest**: they
hold your file paths, and `tmp/` holds verified plaintext file content until a pull renames or sweeps it. Exclude the
folder from iCloud, Dropbox, Syncthing, backup tools and any other synchronisation or backup. Never put it in a
repository. The exclusion list already keeps it out of the published vault. The sequence floor is not in this folder:
it lives in a per-user directory (CLI) or the plugin data, so that deleting this folder does not reset it.

Deleting the folder resets this device's record of the root. There is no plaintext downgrade to guard against any more
(no code reads a plaintext manifest); the sequence floor, which lives outside the folder, is what remains of the record.
It also has a consequence you should not discover later: a device with no record and no
key-slot copy for a root that already holds a manifest is refused by `publish` ("not the publisher"). After deleting
`.ipfs-sync/`, run `pull` with the passphrase: it is a first pull with no baseline, so it trusts what the node serves
(the sequence floor, if it survived, still refuses an older manifest), and every local file that differs from the node's
becomes a conflict copy. Restoring an older copy of the folder is handled by pulling; `--repair` refuses the "ahead"
case there (see above).

### The fixture marker

The guard is still in this tree. The plan removes it in one commit on a separate branch (`mvp-07b-guard-removal`),
cut from `main` once the other code is done, and `main` keeps the guard until the release commit is merged by
fast-forward. That branch does not exist yet. Until it is merged, `publish` and `init` require `.ipfs-sync-fixture` to hold exactly the text `fixture`
(a trailing line feed is allowed), and they check it before they look at the passphrase or send any request. A directory
that `pull` populated carries `pulled-fixture`, so it cannot be published from until you write `fixture` by hand (the
second-device path in "Pull"). Values:

| Marker content | Written by | `publish` and `init` | `pull` |
|---|---|---|---|
| `fixture` | you, or `pnpm fixture:generate` | accepted | accepted |
| `pulled-fixture` | `pull`, when it populated an empty destination | refused | accepted |
| empty, or anything else | earlier releases, or by hand | refused | refused |

A destination that release 0.2.0 populated by pull carries a marker that reads `fixture copy created by ipfs-sync pull`
(other early builds left it empty or wrote `marker`). This tree's `pull` refuses all three of those contents with a
message that says the marker predates this version and must be re-marked deliberately. `publish` uses that wording only
for the `fixture copy created by ipfs-sync pull` text; for an empty marker or `marker` it gives its generic refusal.
To use that directory again you must re-mark it deliberately: write `fixture` into `.ipfs-sync-fixture` yourself
(`fixture` for publish; `fixture` or `pulled-fixture` for pull). That is a statement by you that the directory holds no real notes. Nothing
verifies it. Anyone who can create the file can override the guard, and the guard is an accident guard, not a control.

### Limits that stay

Each of these holds after `mvp-07b` and after the guard is removed. They are here because they are the cases where the
checks in this tool give a false sense of safety.

- Removing 49 percent of the entries is silent. The mass-removal guard stops "every entry" and "more than half"; half and
  below proceed unasked. A vault folder that is merely unmounted looks like every file deleted and is caught; a
  half-mounted one is not.
- Silent per-file corruption of unchanged files by someone who can write to the node is not detected by the publisher.
  The publisher does not re-read blobs it did not write in this run; a reader that decrypts one will notice.
- Concurrent publishes are narrowed, not prevented. A rewrap that loses the race puts the old key-slot file back (a prune has
  nothing to put back), but kubo has no compare-and-swap and a write race on the shared tree is not detected.
- The sequence floor does not stop a node from showing an old copy to a device that has no recorded state. A first pull,
  a reinstalled plugin and a deleted per-user directory all have no record.
- Rewrap does not revoke the old passphrase or any old copy of the key slot.
- The plaintext reader is gone, so a vault published by release 0.2.0 cannot be pulled by this version. Use release 0.2.0
  for that, and treat everything it published as public.

**How a release is gated, and what that proves.** A release is meant to be refused unless a checker passes
(`node tools/check-guard-preconditions.mjs`; exit 0 only when every item passes). It binds the shipped bytes to a tree hash
and a reproducible clean-export build, and requires four records: a review record for that tree (committed under
`openspec/changes/mvp-07b-keys-history-guard-release-2/`), an operator-run record from a manual run in Obsidian desktop
against the shared node, a phone-timing record, and the checklist tests and the limit sentences above in this file and in
`DESIGN.md` section 8. The review record, the operator-run record and the phone-timing record are attestations, not
proofs. The checker makes forging them more work and leaves a trail. A person with repository write access and a
terminal can still produce all three. A terminal and a nonce stop pipes and accidents; they do not stop a program that
drives a pseudo-terminal. The review record is authenticated by git history; the release tool then needs the operator to
type `I accept an unsigned review record for <tree hash prefix>`, and the notes say "unsigned". A change to any scoped file after the review record or after the operator run changes the tree hash, and both must be redone. A one-line fix therefore repeats the review record and
the operator run, and a phone measurement is bound to the exact plugin build. The checker, the phone-timing recorder and
the release tool exist and are covered by tests; the operator-run script does not exist yet, so no release can pass today.
The order and commands are in the operator runbook.

### Not verified

Nothing in this list has been checked, and none of it should be assumed to work: any part of the plugin's encryption
flow inside Obsidian, including Pull, Restore, Resolve fork, the key-management, mass-removal and cost dialogs, the
measure command and desktop Range streaming (the `globalThis.require` lookup); the `keys` commands and `prune-history`
against the shared node or a real kubo; a High-cost key slot on a phone; the encrypted pull against the shared node
and with a real second device; an encrypted publish or pull on a phone; Android; HKDF, HMAC and AES-GCM under Obsidian's
WebView; `requestUrl` with large binary bodies and Range requests, and large-file pull in the plugin; zeroization beyond
the byte arrays the code owns; rollback prevention beyond what a device already accepted (a freeze and a stale first pull
are not detected); an auth-protected kubo endpoint with the plugin; Windows; the real-node behaviour of directory
listings near 2,000 entries; kubo `files/write` overwrite semantics beyond what the shared-node run exercised; whether
kubo reads `arg` from a POST body; the plugin flow.

What was measured on an iPhone (iOS 27.2 beta, Obsidian 1.13.7 build 365), recorded on 2026-10-02 from operator
screenshots and reports and not reproduced by an agent: the release 0.2.0 plaintext pull of 5 files (24 KB) worked, and
so did a pull of a 50 MB and a 5 MB random file (an operator report; time and responsiveness were not recorded).
Argon2id at 64 MiB, t = 3, p = 1 took 980, 1143 and 1133 ms with a longest event-loop gap of 21, 17 and 17 ms in a probe
build (`0.2.1-probe.1`); the Mac baseline for the same function was 990 to 1177 ms. The first pull crashed the app once
(unexplained); the relaunch loop after it was an iOS file-provider hang cleared by restarting the phone. These are
measurements of those builds. They say nothing about the encrypted pull, which has not run on a phone, and Android is
untested. A phone test installs through BRAT from a GitHub pre-release with its own tag, and until the guard is removed
that is a fixture-only build.

What has run on the shared node: `tools/feature-op-mvp-06.mjs` ran twice on 2026-09-30 (task 6.2 and the delivery-cadence feature checkpoint; both exit 0, 121 of 121 checks;
encrypted layout; publish #2 "1 written, 0 removed" at sequence 2; three kill points resumed; refusals sent no mutating
request; all 42 mutating requests stayed under `/obsidian-vault-sync/mvp06-demo/<runid>` and the own key). The
hostile-object variants ran against a local stub only. Argon2id took 844, 1096 and 859 ms wall with a largest
event-loop gap of 39 ms, on the development machine, not a phone. Consequences you should know about: the two
runs left two run folders (`muo58t8n-ed2e9a64` and `muo6r3gr-8907bcc4`) and their pins on the node, and repointed the
IPNS key `obsidian-vault-sync`: from the mvp-05 plaintext demo root `/ipfs/bafybeihh4slp53ygsfk454pm4tqjbccd5tu6s6egu37gai2mvfnbw6aa7e`
to the first run's root `/ipfs/bafybeiec4bfadcs3iaowvg4yiwh66ivnrn3sym4r6h4x4xtw262un5jxwu`, and then to the second run's root
`/ipfs/bafybeifu652yt23rpx4d4wgzd4rvyehf6xob6m53dzy6rntni2osl6oz3u` (current). Other keys are unchanged. In that run `--repair` on an older genuine manifest (behind) succeeded without a prompt (only ahead and rebuild
ask), and the wrong-passphrase refusal sent two read-only requests and no mutating one. Reviews 0.1, 0.2, 2, 2b, 3, 3b, 4-1, 5, 5b and 5c are done. Each was a static read by one
model; the cross-model judge was not run. Review 5c re-read the review-5 fixes R5-01 to R5-08 statically, with nothing
executed. Its corrections (C5-01, C5-03, C5-04, C5-05) have not been re-read by a reviewer, and C5-02 (the plugin lock
token is not re-checked immediately before each node write) is open. Details: `DESIGN.md` section 8.

## Your node's quirks (discovered during bring-up, encoded in the code)

1. **Form-encoded RPC args are dropped by the reverse proxy.** Every kubo argument
   must travel in the **query string**. The shared kubo client (`src/kubo`, used by the
   plugin and the CLI) sends arguments that way.
2. **`files/write` requires a multipart body with field name `data`** (not a raw
   body). This is non-standard for kubo — likely the proxy's own requirement.
3. **`name/resolve` needs `nocache=true`.** Kubo caches IPNS lookups for the record TTL,
   so without it a pull right after a publish can resolve the previous snapshot. The CLI
   always sends it.
4. **CORS blocks the Obsidian WebView.** The node answers requests with the origin
   `app://obsidian.md` with 403 and sends no CORS headers, so the WebView's `fetch` cannot
   reach it. The plugin sends every node request through Obsidian's `requestUrl`, which is
   not subject to CORS. The CLI uses plain `fetch` and is unaffected.

## ⚠ Security: your RPC endpoint is wide open

`https://ipfs.prometheusags.ai/api/v0/` currently accepts **unauthenticated
writes from the entire internet**: anyone can `add`/`pin` garbage, create IPNS
keys, or republish *your vault pointer* if they learn its key name. Your node also
hosts other projects' keys (`consult-capture`, `gomark-relay-lab`, `prince-live`).
Before this becomes your real sync backbone:

- Put auth in front of the RPC (nginx/basic-auth or a bearer token at the proxy),
  and set the same token in the plugin's settings and pass it to the CLI with
  `--auth bearer` and `IPFS_SYNC_AUTH_TOKEN`.
- Or restrict `/api/v0` to your IPs/VPN.
- Long-term: keep the RPC private; expose only a read-only gateway for content.

Until then, treat anything published by release 0.2.0 as public. With this tree, an encrypted vault is protected by the
passphrase and by nothing else on the node: the node can still delete, replace or withhold your objects, and see sizes
and timing.

## Agentic layer: what the UI will be

The search and chat layer that sits on top of sync is designed, not built. The design authority is `docs/design/`
(read `docs/design/README.md` first); spec `docs/012-vault-agent-ui.md` is the pointer in the numbered series.
In short:

- **Vault agent view** in the right sidebar with three tabs. **Search** finds notes by meaning with a similarity score
  per row and opens, links or feeds the chat. **Chat** has two modes: **Notes**, a retrieval-augmented chat that
  answers only from passages in your vault, cites each sentence, and says "Not in your notes" instead of guessing; and
  **Agent**, which adds skills, tools and approval cards and shows every step it took. **Index** shows the embedding
  model, coverage, the queue, and a one-tap rebuild, because the index is a cache that rides the vault snapshot.
- **Quick ask**: a Quick-switcher-style popup (bottom sheet on a phone) that searches as you type and can answer one
  question before handing off to the view.
- **Control center**: searchable settings in six sections with Security first (device identity, pairing, grants with
  expiry, vault key), and a consequence dialog on every destructive action.
- A **lane chip** on every agent surface says whether an answer was produced on this device, by a remote agent, or
  while offline. Everything is styled with Obsidian's own variables, so it follows your theme and accent.

The concept screens open in a browser and have working interactions with scripted data; nothing in them calls a node
or a model yet.

## Roadmap

- **Phase 2 — real sync:** embed [Helia](https://github.com/ipfs/helia) + [OrbitDB](https://orbitdb.org)
  in the plugin. One op-log record per file (path, content CID, mtime, tombstones);
  Merkle-CRDT merging makes concurrent edits on two devices conflict-free; the
  snapshot layer in this repo becomes the bootstrap/restore path. The RPC seam is
  the kubo client in `src/kubo` — that's the only thing Phase 2 replaces.
- **Phase 3 — the AI layer:** embeddings computed on your Mac, stored as
  content-addressed data pinned to the vault root — every device gets the index
  that matches its snapshot for free. Semantic search, RAG chat, auto-backlinks.
  (This replaces the vault-chat plugin and its plaintext API key.) The user
  interface for this phase is designed in `docs/design/` (see "Agentic layer"
  above).
- **Phase 4 — mobile + always-on pinning** (`ipfs-cluster` or a second node).

## Loose end on your node

`/obsidian-vault-staging` in MFS contains older content (FLINT specs, meeting
recordings) from a previous sync attempt. This tooling writes only under `/obsidian-vault-sync/`
and never touches it. Delete it
from MFS yourself when you've confirmed you don't need it.

## License

MIT, copyright KnowMe AI, LLC. See `LICENSE`. Release history: `CHANGELOG.md`.
