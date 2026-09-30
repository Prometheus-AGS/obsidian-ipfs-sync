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
> - **Pulling an encrypted vault is not implemented** (planned for `mvp-07`). Nothing you publish with this tree can be
>   pulled back by this tool yet, on any device.
> - **Release 0.2.0** (tagged `v0.2.0`, a GitHub pre-release) is the plaintext build: it has no encryption, and
>   everything it published is readable by anyone who obtains the CID. The encryption described below is not in 0.2.0;
>   it is unreleased work after it.
> - The release demonstration targets Obsidian desktop on macOS. It is not recorded in this repository, so nothing is
>   verified on any platform yet. Mobile, Windows and Linux are not verified either.

## What's here (Phase 1)

| Piece | Where | What it does |
|---|---|---|
| Obsidian plugin | `src/main.ts` → `dist/plugin/` (`main.js`, `manifest.json`) | Publish (encrypted), Pull and Status commands, settings tab with an Encryption section, optional auto-publish. Fixture vaults only. Pull cannot read an encrypted vault yet |
| CLI init | `ipfs-sync init` | The only way to create an encrypted vault: generates the passphrase and the key slots |
| CLI publish | `ipfs-sync publish` | Encrypt and send only changed files to the node's MFS, then publish the snapshot to the IPNS key |
| CLI pull | `ipfs-sync pull` | Reads only plaintext (version 1) roots published by release 0.2.0, and only with `--allow-plaintext-v1`; refuses an encrypted root |
| Exclusions | `src/sync/exclusions.ts` | Shared exclusion list: trash, workspace churn, this dev folder and the fixture marker file. The whole `.obsidian/plugins/` folder is never published or pulled: plugin code and plugin data are device-local |

**Mutable pointer:** the project IPNS key `obsidian-vault-sync` on your node. `publish`
creates it if absent and records its ID in the config file (`ownedKeys`). Each publish
points the key at the CID of the MFS root, which holds `current/` (encrypted files under opaque names in
two-character prefix folders), `manifests/` (one encrypted history copy of the manifest per publish),
`manifest.enc` and `keyslots.json`.
Swap for DNSLink (`_dnslink.ipfs.prometheusags.ai` → `/ipfs/<cid>`) whenever you
want a human-readable name — same content, one DNS record.

**Conflict policy (pull, CLI and plugin; both run the same engine):** pull never deletes and never loses
data. If a local file differs from the remote version, the remote becomes
canonical and the local content is preserved as `name (ipfs conflict YYYY-MM-DD).ext`
(the extension is kept so the copy opens in the same app). Pull leaves files that are
remotely deleted in place and reports them; remote deletions are not applied.
Pull also refuses manifest paths it must not write: absolute paths, `..` segments,
backslashes, anything inside `.ipfs-sync/`, anything under `.obsidian/`, and
anything on the exclusion list. A refused path is counted as failed; the rest of the pull continues.
True merging arrives with the Phase 2 op-log. In this tree the engine can only run against a plaintext root from
release 0.2.0; see "Pull in this tree" below.

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

- Commands (`Ctrl/Cmd+P`): **IPFS Sync: Publish vault**, **IPFS Sync: Pull vault** and
  **IPFS Sync: Show status**. Two ribbon icons run Publish and Pull. An optional auto-publish
  interval (minutes, 0 = off) is set in the settings tab.
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
- **The plugin cannot repair.** `--repair`, `--recover-slots` and `--break-lock` exist only in the command line tool. The plugin can clear a publish lock that is at least 15 minutes stale ("Clear stale publish lock").
  When a publish is refused and the message names one of them, run `ipfs-sync publish` for that vault.
- Pull reads only: name resolve, key list and gateway reads. It changes nothing on the node. It saves
  every open editor first, so an edit that exists only in an editor counts as a local edit. Progress
  and the result show as a notice and in the status bar. The result names the fetched,
  unchanged, conflict, failed and remote-deletion counts and up to three conflict copies. It says
  "incomplete" when any file failed. **In this tree Pull cannot bring files:** it refuses an encrypted root ("pulling
  encrypted vaults is not supported yet") and remembers that, and the plugin has no setting that lets it read a
  plaintext root.
- Pull target: the **pull name** setting (an IPNS key ID; a `/ipns/` prefix is accepted). When it is empty the
  plugin uses the ID of the publication key, but only if that key exists on the node and is recorded as owned.
  Otherwise Pull stops before fetching and tells you to set a pull name.
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
- `.obsidian/plugins/` is never published and never pulled: plugin code and plugin data, including this
  plugin's own `data.json` with your credentials, stay on the device. Those credentials are stored in plain text.

### Pull in this tree

The earlier "pull demo" (publish a fixture vault, then pull it into a second vault) no longer works with this tree,
because `publish` now encrypts and pull cannot read an encrypted root. It works only with the release 0.2.0 build
(`v0.2.0`), which published plaintext. With this tree you can publish an encrypted fixture vault (see "Encrypted
vaults") but not pull it back; pulling arrives with `mvp-07`. A plaintext root left over from 0.2.0 can still be
pulled with `ipfs-sync pull --allow-plaintext-v1`, unless the destination has ever seen an encrypted vault, in which
case pull refuses it as a possible downgrade. Anyone who can write to the node can forge a plaintext manifest, which
is why that reader is off by default.

### Plugin limitations

- Encryption is implemented but not independently reviewed and not verified in Obsidian; fixture vaults only (above).
- The plugin cannot detect symbolic links, because Obsidian's file adapter has no `lstat`. The CLI refuses to
  write through a symlink; the plugin cannot make that check. Do not place symlinks in a vault you sync.
- Obsidian's `requestUrl` transport buffers each whole response body in memory. The one-segment memory bound and the
  size caps that protect the CLI give no protection for what `requestUrl` has already buffered, and Range requests
  reduce the exposure only against gateways that honour them. Multi-megabyte binary bodies through `requestUrl` are
  unverified.
- Writes go through a temporary file in `.ipfs-sync/tmp/` and then a rename. Where the destination already exists,
  the plugin removes it first and then renames, so a crash in between can leave the file missing until the next pull.
  This window has not been tested.
- The plugin's publish lock file (`.ipfs-sync/publish.lock`) is best effort. It is created by a check and then a rename
  (two steps), read back after the rename and compared (`src/plugin/adapter-lock-file.ts`), and checked once more right
  after acquisition and before the publish starts (`src/plugin/lock-token-check.ts`). There is no check immediately
  before each write to the node, so a CLI publish and a plugin publish can overlap for up to one heartbeat interval
  (about 60 s) on a platform where rename overwrites. What `adapter.rename` does with an existing target in Obsidian is
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
- The setup, unlock, abandon and clear-stale-lock dialogs have never been run inside Obsidian. The abandon dialog opens from the
  "Abandon this vault" command and from a button in the settings tab's Encryption section; that wiring is covered only
  by tests with a fake host. After an abandon, a second Publish can open a second unlock dialog over the first; this is
  cosmetic and accepted.
- Mobile, Windows and Linux are not verified.

## CLI usage

Requires Node >= 24.15 and pnpm. Build once, then run the CLI (or the `ipfs-sync` bin):

```bash
pnpm install && pnpm build

node dist/cli/ipfs-sync.mjs status
node dist/cli/ipfs-sync.mjs init <vault> [--passphrase-file <path>]
node dist/cli/ipfs-sync.mjs publish <vault> [--repair] [--recover-slots] [--break-lock] [--allow-full-reupload]
node dist/cli/ipfs-sync.mjs pull <vault> --allow-plaintext-v1 [--name <ipns-id>] [--manifest <currentCID> | --manifest-file <path>]
```

- `status` shows node identity, MFS listing, gateway fetch, write probe and key state.
- `init` creates the encrypted vault for `<vault>` (next section). `publish` never creates one.
- `publish` sends only changed files, always encrypted, and needs the vault passphrase. It accepts only a vault whose
  `.ipfs-sync-fixture` file holds the text `fixture`, and needs an MFS root strictly below `/obsidian-vault-sync`.
- `pull` fetches only files whose sha256 differs, from a plaintext root only (see "Pull in this tree").
  `pull` without `--name` uses the ID of the owned `obsidian-vault-sync` key;
  `--manifest` restores an earlier snapshot; `--manifest-file` reads a local manifest.
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
can serve you an older valid snapshot; this tree does not detect a rollback. Without the passphrase it cannot read
names, paths, contents or the manifest, and cannot make you encrypt under a different key.

Three consequences to accept before you use it:

- **The key slot is public.** Anyone who has the root CID can download `keyslots.json` and guess passphrases offline,
  forever, at the cost of Argon2id. That is why passphrases are generated: 23 random symbols (115 bits) plus 2 check
  symbols. A leaked passphrase, plus any copy of the slot (every old root stays pinned on the node and this project
  never unpins), opens every state you ever published.
- **A passphrase change would not revoke anything.** Rewrapping the slot under a new passphrase (not implemented yet)
  would not revoke the old passphrase or any old copy of the slot; an old copy keeps opening the same vault key. Only
  re-encrypting the vault under a new key revokes access, and nothing here does that.
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

`publish` reads it from exactly one of:

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
- **`--repair`** continues past a refusal that says the node is behind this device's record, the node is ahead of it
  (for example after restoring `.ipfs-sync/` from a backup), or a manifest or local record is unreadable after a torn
  write. It works only when the node's manifest authenticates with your key, belongs to this vault, and the node's
  `keyslots.json` equals this device's copy byte for byte. It publishes at one above the greater of the sequences it
  knows. In the "ahead" case it warns that changes made by any other publisher will be discarded, and when it rewrites a
  missing or unreadable `manifest.enc` it warns that whatever the node held there cannot be recovered; both ask first.
  The "behind" case (the node serves an older snapshot) does not ask. `--repair` is also the only way to have the tool
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
- Two devices publishing to one root are not supported. A device with no record of a root that already holds a manifest
  is refused before any derivation ("this device is not the publisher"), and pulling an encrypted vault is not
  implemented yet.
- If none of these apply, the way out is a new MFS root and a new vault (`init`). The refusal messages call this the
  "abandon action": run `ipfs-sync abandon <vault>` (add `--mfs-root` to name the root), or use the plugin command
  "Abandon this vault" (also a button in the Encryption section of the settings tab). It moves this device's key-slot
  copy, sync state and journal for that root into `.ipfs-sync/abandoned-<h>-<ms>/`. It never contacts the node and
  deletes nothing. It records the encrypted-seen latch first, so it does not re-open the plaintext reader. On a terminal you must type `abandon`; without one it does nothing unless you pass `--yes-abandon`.

### History growth

Every publish that changes something adds one file to `manifests/` on the node: an encrypted copy of the whole manifest,
about 4 to 14 MB for a vault of 5,000 to 20,000 files, pinned forever. The tool lists that folder before it writes
anything. It warns at 1,500 files and refuses at 1,999, with a message that names `ipfs-sync prune-history`.
**`prune-history` does not exist in this build.** At the limit, publishing stops for that root. The supported way on is a
new MFS root and a new vault; you will re-upload everything, with a new passphrase. An actively edited vault on the
auto-publish timer can reach the limit in days to weeks. Removing old `manifests/<cid>.enc` entries yourself with kubo
is untested and not supported.

### Local state: `.ipfs-sync/`

`<vault>/.ipfs-sync/` holds, per MFS root, `state.<h>.json`, `journal.<h>.json` and `keyslots.<h>.json`, plus
`publish.lock` and, after a pull that met an encrypted root, `encrypted-seen.json` (`<h>` is the first 16 hex characters
of the SHA-256 of the MFS root). **The state and journal are plaintext at rest**: they hold your file paths. Exclude the
folder from iCloud, Dropbox, Syncthing, backup tools and any other synchronisation or backup. Never put it in a
repository. The exclusion list already keeps it out of the published vault.

Deleting the folder resets everything, including the record that a root held encrypted content, which is what stops a
plaintext downgrade on pull. (`abandon` does not reset that record; only deleting the folder does. An `abandoned-<h>-<ms>` backup folder also counts as evidence of an encrypted vault: the CLI sees it, and the plugin does since a correction made after review 5c, which is covered by fake-adapter tests only and has not run in Obsidian.) It also has a consequence you should not discover later: a device with no record and no
key-slot copy for a root that already holds a manifest is refused ("not the publisher"), and this build cannot pull an
encrypted vault. After deleting `.ipfs-sync/`, continuing means a new MFS root and a new vault. Restoring an older
copy of the folder is handled by `--repair` (the "ahead" case) under the conditions above.

### The fixture marker

Until `mvp-07` removes the guard, `publish` and `init` require `.ipfs-sync-fixture` to hold exactly the text `fixture`
(a trailing line feed is allowed), and they check it before they look at the passphrase or send any request. Values:

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

### Not verified

Nothing in this list has been checked, and none of it should be assumed to work: any part of the plugin's encryption
flow inside Obsidian; HKDF, HMAC and AES-GCM under Obsidian's WebView; the Argon2id cost on a phone (64 MiB and 3
iterations is unmeasured there); `requestUrl` with large binary bodies; zeroization beyond the byte arrays the code
owns; rollback prevention (there is none); an auth-protected kubo endpoint with the plugin; Windows; the real-node
behaviour of directory listings near 2,000 entries; kubo `files/write` overwrite semantics beyond what the shared-node
run exercised; whether kubo reads `arg` from a POST body; the plugin flow.

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

## Roadmap

- **Phase 2 — real sync:** embed [Helia](https://github.com/ipfs/helia) + [OrbitDB](https://orbitdb.org)
  in the plugin. One op-log record per file (path, content CID, mtime, tombstones);
  Merkle-CRDT merging makes concurrent edits on two devices conflict-free; the
  snapshot layer in this repo becomes the bootstrap/restore path. The RPC seam is
  the kubo client in `src/kubo` — that's the only thing Phase 2 replaces.
- **Phase 3 — the AI layer:** embeddings computed on your Mac, stored as
  content-addressed data pinned to the vault root — every device gets the index
  that matches its snapshot for free. Semantic search, RAG chat, auto-backlinks.
  (This replaces the vault-chat plugin and its plaintext API key.)
- **Phase 4 — mobile + always-on pinning** (`ipfs-cluster` or a second node).

## Loose end on your node

`/obsidian-vault-staging` in MFS contains older content (FLINT specs, meeting
recordings) from a previous sync attempt. This tooling writes only under `/obsidian-vault-sync/`
and never touches it. Delete it
from MFS yourself when you've confirmed you don't need it.

## License

MIT, copyright KnowMe AI, LLC. See `LICENSE`. Release history: `CHANGELOG.md`.
