# Operator runbook: the encrypted vault

Audience: the person running `ipfs-sync` against a kubo node. Scope: `init`, `publish` and the plugin's Publish for
the encrypted publish path of change `mvp-06`, and `pull`, the plugin's Pull, Restore and Resolve fork, and publishing
from a second device for change `mvp-07a`. Status: fixture vaults only, encryption implemented but not
independently reviewed to the standard real notes need and never run inside Obsidian. The feature-operation script of
`mvp-06` ran twice against the shared node on 2026-09-30 (below); the plugin flow has not (`README.md`, `DESIGN.md`
section 8). The pull in this file is covered by automated tests with fake nodes. It has not been run inside Obsidian, on
a phone, or against the shared node by the operator; that run belongs to change `mvp-07b`. Where a sentence
below says what pull does, it means "the code does this", not "this was seen working".

The refusal texts below are quoted in part from the code (`src/sync/publish-refusals.ts`, `src/sync/vault-keys.ts`,
`src/sync/pull-sequence.ts`, `src/sync/encrypted-pull.ts`, `src/core/config/node-safety.ts`). If a message on your
screen differs, the code wins and this file is stale.

## Before you start

| Need | Detail |
|---|---|
| A fixture vault | `.ipfs-sync-fixture` at the vault root holding the text `fixture`. `pnpm fixture:generate <dir>` writes one. Anyone who can create the file can override this guard; it is not a control |
| An MFS root | `--mfs-root /obsidian-vault-sync/<name>`, strictly below `/obsidian-vault-sync`. One root per vault. `init` needs it completely empty |
| A place to keep the passphrase | A password manager. There is no recovery |
| Local storage that is not synchronised | `<vault>/.ipfs-sync/` is plaintext (paths), and its `tmp/` folder holds verified plaintext file content while a pull runs. Keep it out of iCloud, Dropbox, Syncthing and backups |
| For a second device | The same MFS root and publication key name, the owned key adopted, the passphrase, and a destination that is empty or carries the `fixture` or `pulled-fixture` marker. See "Second device" |

## Routine

1. Create: `ipfs-sync init <vault> --mfs-root /obsidian-vault-sync/<name>` on a terminal, or add
   `--passphrase-file <path>` for a 0600 file. Save the passphrase before doing anything else. The interactive display
   stays in terminal scrollback and in `script` and `tmux` logs.
2. Publish: `IPFS_SYNC_PASSPHRASE_FILE=<path> ipfs-sync publish <vault> --mfs-root /obsidian-vault-sync/<name>`, or run
   it on a terminal and type the passphrase at the prompt. Read the `sequence` and `N written, M removed` lines. A run
   with nothing to do prints `nothing changed` and does not touch the IPNS record.
3. Plugin: Publish opens the setup dialog on a device with no vault, otherwise the unlock dialog once per session. The
   timer never opens a dialog and skips while the vault is locked.
4. After a crash, a killed process or a dropped connection: run the same `publish` again. Do not delete `.ipfs-sync/`.
5. Another device, or a restore: `ipfs-sync pull <vault> ...` (next section), with the same passphrase.

Passphrase sources for `publish` and `pull` (exactly one): `IPFS_SYNC_PASSPHRASE_FILE`, `IPFS_SYNC_PASSPHRASE`, or the
prompt. Setting both variables is an error. An environment variable is readable by your other processes and inherited by
child processes; prefer the prompt for interactive use and the file for automation.

## Pull, restore and fork resolution

`ipfs-sync pull <vault> [options]` brings a directory to the published state of an encrypted vault. It takes the same
`publish.lock` as `publish` and reads only (`name/resolve`, `key/list`, listings, gateway reads); it writes nothing to
the node. A root that holds key slots goes to the decrypting reader. A plaintext (version 1) root from release 0.2.0 is
read only with `--allow-plaintext-v1`, never into a destination that has seen an encrypted vault, and the flags marked
"encrypted only" below are refused for it before anything is written.

In order, and what each step may write:

1. Flag combinations that are never valid are refused before any request (below).
2. The destination must be absent, empty, or carry the marker `fixture` or `pulled-fixture` (see "Second device" for
   what that means for publishing). Anything else is refused before any request, with exit code 2.
3. The lock is taken. This creates `<vault>/.ipfs-sync/` (and the vault directory) if they are missing, even if the pull
   later stops. `.ipfs-sync/tmp/` is swept. The name is resolved and the root listed once.
4. Unlock. A device that holds a key-slot copy for this root unlocks that copy first, so a wrong passphrase is refused
   locally. A device with no copy unlocks the node's slots; a slot that asks for more than the default cost (64 MiB, 3
   iterations) has its cost shown and asked first (no terminal: refused). `--expect-vault-id` and the record's vault are compared with the slot file before any derivation.
5. `manifest.enc` is authenticated under the key. No file is requested before this succeeds.
6. The verdict is decided against the record (below).
7. First pull only: the sequence, date and device are shown and you answer. Only after a yes are the key-slot copy and
   the floor written.
8. Files. Each path is compared on plaintext sha256 (this device, the last baseline, the node). Blobs are read from the
   immutable tree the authenticated manifest names (`/ipfs/<manifest rootCID>/...`), never from the root's mutable
   `current/`. Each file is decrypted and hashed into `.ipfs-sync/tmp/<id>.part` and renamed over its path only if its
   size and sha256 equal the manifest entry.
9. The state file is written last. A pull that dies before this point leaves whole, verified files and the old state; the
   next pull re-checks them.

### Flags (each one is in `ipfs-sync --help`)

| Flag | Effect |
|---|---|
| `--name <id>` | IPNS key ID to pull from. Default: the ID of the owned key `--key` |
| `--root-cid <cid>` | Pull this immutable root instead of the name. The client does not verify the bytes the gateway returns against the CID; authenticity rests on the vault key |
| `--manifest <cid>` | Read the history entry whose manifest names this tree CID (`manifests/<sequence>-<cid>.enc`, or the older `<cid>.enc`) under the root the name serves |
| `--allow-rollback` | Accept an older sequence as a restore. Needs `--root-cid` or `--manifest`; refused before any request without one, and never accepted for the name. Cannot be combined with `--resolve-fork` |
| `--resolve-fork` | Another device published the same sequence with other content (encrypted only). Needs a terminal and a yes. Name target only |
| `--expect-min-sequence <n>` | Refuse a manifest whose sequence is below `n` (encrypted only) |
| `--expect-vault-id <id>` | Refuse unless the vault id (32 lowercase hex characters) matches; checked before any key derivation (encrypted only). `init` prints it on the `vault created` line |
| `--accept-first-pull` | The non-interactive yes to the first-pull question. It skips the question on a terminal too. Without a terminal a first pull is refused without it |
| `--max-bytes <n>` | Ask before fetching more than `n` bytes of file content. Default 536870912 (512 MiB) |
| `--accept-large` | The non-interactive yes to that question. Without a terminal a larger pull fetches nothing and exits 1 |
| `--list-versions` | Print the newest 20 history entries by name, with date and device for each file of at most 8 MiB after unlocking. Reads only |
| `--allow-plaintext-v1`, `--manifest-file <path>` | The plaintext reader, unchanged |

Exit codes: 0 when every file that had to be written was written and verified, or was skipped as expected; 1 when a file
failed verification or was not fetched, a path was skipped as unsafe, or the pull stopped at a check (wrong passphrase,
rollback, fork, a held lock, a first pull that was not confirmed); 2 when the invocation or destination is refused before
a request is sent (including `--resolve-fork` without a terminal).

The output lists integrity-failed files, files not fetched and skipped paths apart (`integrity-failed`, `unfetched`,
`skipped (expected)`, `skipped (unsafe, shape|platform)`), then `remote-deleted` and `locally modified` paths, the root
CID, the snapshot CID, the sequence and one summary line. An `unsafe` skip is a path no honest publisher produces, or a
name another platform can write (Windows forms, reserved names, 8.3 shapes, case-fold collisions): it is not written, on
every host including Linux (a Linux vault's `CON.md` is not restored by a Linux pull), it is carried unchanged in this
device's publishes, and it makes the pull exit 1. An `expected` skip is a path under `.obsidian/` or on the exclusion list, which an older build's
manifest can hold: it is not written and does not change the exit code.

### The record and the sequence floor

This device's record for a vault is the higher of `highestSequence` in `.ipfs-sync/state.<h>.json` and the floor. The
floor is `sequence-floor.json` in a per-user directory outside every vault (CLI: `$XDG_STATE_HOME/ipfs-sync` when that is
set, else `~/Library/Application Support/ipfs-sync` on macOS, `%LOCALAPPDATA%\ipfs-sync` on Windows, otherwise
`~/.local/state/ipfs-sync`; plugin: the `deviceStore` section of the plugin data). It holds, per vault ID, the highest
manifest sequence this device accepted in any directory and that manifest's identity. It survives `abandon`, deleting
`.ipfs-sync/` and a changed MFS root. It keeps at most 64 vaults; beyond that the entry with the oldest write time is
dropped.

What the verdict does with it, first match wins:

| Candidate against the record | Result |
|---|---|
| No record | First pull: shown and confirmed (below) |
| A different vault | Refused: "this directory (or this device's sequence floor) records a different vault than the one being pulled" |
| Lower sequence, name target | Refused: "the node serves sequence N but this device has recorded sequence M; the node may be serving an older state or may be hostile, so nothing was changed" |
| Lower sequence, `--root-cid` or `--manifest` | Refused unless `--allow-rollback`; with it, a restore |
| Same sequence, other content | Fork: refused with "run the pull with --resolve-fork" for a name target; never accepted through an explicit target |
| Same sequence and content | Nothing to do |
| Higher sequence | Pull; the record is raised |

The record is raised by a first pull and a newer pull. No verdict lowers it.

Limits you must know:

- **Deleting the per-user directory, the plugin data, or reinstalling the plugin removes the floor.** The vault's own
  state file is then the only record, and a directory with neither takes a first pull with no baseline.
- **A first pull has no baseline.** It trusts what the node serves. The sequence, date and device it shows were chosen by
  whoever holds the vault key; nothing in the pull can confirm them.
- **Rollback is caught only against what this device already accepted.** A node can also freeze a vault (withhold
  updates) and no check here sees it.
- **A key holder can ratchet a sequence.** Someone who holds the vault key can publish a manifest with a very high
  sequence. Every device that pulls it records it, and honest manifests below it are then refused as older. Recovery:
  delete the floor file and the affected `state.<h>.json` files, then pull again as a first pull. The floor file holds
  every vault's floor, so deleting it resets them all.
- **A root CID is only as trustworthy as the gateway that serves it.** `--root-cid` and `--manifest` name what the gateway
  returns; the client does not check the returned bytes against the CID. A forged or substituted object still fails
  authentication under the vault key. Withholding and replaying an older genuine object are not stopped by that.

### First pull

On a terminal it prints the target, sequence, publication date, device, file count, up to three skipped paths, and two
fixed statements (three for `--root-cid` or `--manifest`), then asks "Pull this vault into this directory for the first time?". Without a terminal it needs
`--accept-first-pull`. A declined or unconfirmed first pull writes no file, marker, state, floor or key-slot copy
(the lock may leave an empty `.ipfs-sync/` folder). Use `--expect-vault-id` (the id `init` printed) and
`--expect-min-sequence` (the `sequence` that `publish` printed) when you have them: they are checked without trusting the
shown values.

### Restore an older version

`ipfs-sync pull <vault> --list-versions` shows the newest 20 history entries by file name. The sequence comes from the
name, which the node chooses, so treat it as a label; names written before the sequence prefix (`<cid>.enc`) have no order
and are listed last as `legacy`. Then
`ipfs-sync pull <vault> --manifest <cid> --allow-rollback` (or `--root-cid <cid> --allow-rollback`) restores one. A
restore adds files and replaces files that differ; it never deletes a file that exists only in later versions. A file you
edited locally is kept first as a conflict copy named `<name> (ipfs conflict YYYY-MM-DD).<ext>` (the date is local; a
second copy the same day gets a counter inside the parentheses). The recorded highest sequence stays, the state records
`restoredFrom`, and your next publish makes the result a new version, one sequence above the node's.

### Fork resolution

A fork is this device's sequence N+1 against the node's different sequence N+1: another device published at about the same
time and its `name/publish` came last. `ipfs-sync pull <vault> --resolve-fork` states what it will do and needs a yes on a
terminal. Where both this device and the node changed a file, this device's text is kept as a dated conflict copy and the
node's text takes the path. Files only this device changed stay and are published next, as the sequence after the node's.

Fork resolution merges against the common ancestor, the manifest at sequence N that this device built on, found in the
node's history. It uses an entry only if its name carries the prefix N, it authenticates under the vault key for the same
vault and sequence, and its identity equals the one this device recorded; exactly one entry may match. **Where there is no
ancestor, every file that differs from the node's becomes a conflict copy and the node's text takes the path.** That
happens when this device has no record of the manifest it built on (it pulled, or its state predates the record), when
the history lacks an entry with that prefix (pruned, or written with legacy names), and when none or several entries match.
Nothing local is lost; you get more copies to sort out. The pull prints which case applied.

### Files this device could not restore

A file that failed verification (`integrity-failed`) or could not be fetched (`unfetched`: the free space check failed in
the CLI, the plugin's ranged source refused it, a ceiling was declined, the write failed) is reported, and the pull exits
1. The pull is not lost: the state records the node's entry for the path as "unmaterialized" and marks the pull
incomplete. **Your next publish keeps that entry as the node has it and publishes nothing from this device for that path.**
The next pull tries the path again, and a path this device holds with equal content is simply marked restored.

### Second device

Pulling needs only the passphrase and the root. Publishing from the second device needs three more things, which the
plugin's first-pull dialog also lists:

1. The same MFS root and the same publication key name as the device that created the vault.
2. The owned key adopted: the key's ID in `ownedKeys` in the config file (or `--owned-key <id>` for one run); in the
   plugin, "Adopt a key by ID" under Owned key IDs. Without it `publish` refuses.
3. Pull before publishing, so the first publish builds on what the node holds. A publish to a root that has moved says
   "Run pull first, then publish again." and writes nothing.

Marker: a directory that `pull` populated carries `pulled-fixture`, which `publish` refuses until the encryption guard is
removed (`mvp-07b`). To publish from it, write `fixture` into `.ipfs-sync-fixture` yourself. That is your statement that
the directory holds no real notes, and nothing verifies it.

Concurrent publishes from two devices are narrowed, not prevented. A publish reads the publication name before its first
write and again right before `name/publish` and refuses ("another device may have published ...") if it moved. kubo has no
compare-and-swap, so a publish that starts between those reads and the write still wins or loses by timing, and a write
race on the shared MFS tree is not detected. The publisher's drift guard removes stray blobs only when it has never seen
another device and the node's latest manifest names this device, so it protects another device's blobs only after this
device has pulled a manifest of that device. The first overlap by a device that has never seen the other can still make
the other device's read-back fail; that publish fails and is retried. A routing timeout on a vault's first publish counts
as "not found". On the operator's node the two cannot be told apart: for a name that was never published it answered
`could not resolve name` identically with `dht-timeout` set to 1 ms, 1 s and 10 s (`src/kubo/ipns.ts`).

`publish --repair` in the "node is ahead" case is refused when a floor exists for the vault or this device has a usable
state, with "Run pull first, then publish again." It stays available only for a state file that exists and does not
decode, with no floor, and then only after its warning and a confirmation.

### Exclusions: `.obsidian/` and `.smart-env/`

The default exclusion list now holds `.obsidian/` (the whole configuration folder), `.smart-env/`, `.trash/`,
`.ipfs-sync/`, `.ipfs-sync-fixture`, `.DS_Store`, `node_modules/` and `.git/`. The defaults cannot be removed; you can add
your own. **`.obsidian/` no longer syncs.** Plugin code and plugin data stay on each device, and a pull refuses any
manifest path under it (a pulled plugin file would be code execution). A vault whose configuration folder has another name
adds that folder in the plugin; the CLI does not know it.

The list's hash (`excludesHash`) changed: it is now `ebd10cbd1cd9776229910af44cc1455550e840ba6aad25e8ba9434b0df32da0f`,
and before this change it was `062286b6...ddc9d`. A pull of a manifest with a different hash prints one warning,
`the exclusion lists differ: this device <hash>, manifest <hash>. Every local file was re-verified by content; nothing was
deleted.`, and hashes every local file instead of trusting size and modification time. Entries of an old manifest under
`.obsidian/` are skipped as expected (exit 0). They leave the manifest at your next publish, which also ends the warning.

`.smart-env/` is the embeddings folder of the Smart Connections plugin. It is excluded by default because of what a desk
study read in that plugin's source and issues (`assessment-smart-connections.md` under
`.kbd-orchestrator/phases/mvp/children/mobile-feasibility/`; nothing was installed or run): the plugin queues a re-import
13 seconds after a note is edited and appends to files in `.smart-env/`; its README tells users of third-party sync to add
`.smart-env/` to their ignore patterns; and its author advised against syncing the embedding files in an issue thread. On
our side, the idle check (a path, its size and its modification time must all equal the record) cannot apply while those
files change, and each non-empty publish adds one history file toward the warning at 1,500 and the refusal at 1,999. This
file claims nothing about Smart Connections beyond that; its behaviour on a running vault was not observed.

### Where the plugin differs

- Commands: "Pull vault", "Restore an older version" and "Resolve fork". Pull never passes the rollback flag; only Restore
  does. Restore lists the newest 20 history names, reads the date and device of files of at most 8 MiB, and loads and
  authenticates the chosen entry before it asks you to confirm; the dialog shows that entry's own sequence and date, and a
  name that disagrees with its entry stops the action. Restore and Resolve fork need a pull name that is an IPNS name, not
  an explicit `/ipfs/<cid>` root.
- The Pull IPNS name accepts a key ID, `/ipns/<id>` or `/ipfs/<cid>` (an explicit root). The setting "Ask before pulling
  more than (MB)" takes 64 to 8192 and defaults to 512. If you decline, nothing is fetched and those files stay unfinished.
- The Encryption section of the settings tab has a "Pull record" row: the highest sequence recorded, whether the last pull
  was complete, how many files are unfinished, and the sequence a restore took.
- The catch-up pull never opens a dialog: a locked vault or a first pull makes it refuse instead of asking.
- A key slot above the default Argon2id cost has no confirmation dialog in the plugin; use the CLI for that vault.
- Memory. The CLI streams each blob and holds about one segment per file in flight. The plugin reads blobs through Obsidian's `requestUrl`,
  which buffers whole response bodies, in segment-aligned Range requests. Its in-flight ciphertext and plaintext are
  budgeted at 128 MiB (a design budget, not a measurement). A gateway that ignores the Range header answers with the whole
  blob: up to 32 MiB is accepted, and a larger one is discarded after the transport buffered it, so the file is
  `unfetched`. Blobs with segments below 1 MiB are `unfetched` in the plugin. **Large-file pull in the plugin is not
  advertised as working until the `mvp-07b` operator run records the outcome.** A local file above the read cap cannot be
  compared and is reported unfetched.
- `rename` in the plugin is not atomic: it removes an existing target, then renames. A crash between the two can leave a
  file missing until the next pull.

### Other limits specific to pull

- **Temporary files are plaintext at rest.** `.ipfs-sync/tmp/<id>.part` (and `<id>.copy` for a conflict copy) holds
  verified plaintext until it is renamed into place. A killed pull can leave some. The next pull sweeps them while it
  holds the lock; the plugin sweeps on load only if it can take the lock, and skips the sweep when the lock is held. Keep
  `.ipfs-sync/` out of backups and sync.
- **The size and modification-time shortcut can overwrite an edit.** A local file whose size and modification time equal
  the recorded values is not hashed (unless the exclusion lists differ), so a file edited in place with the same size and a
  preserved time is treated as unedited and is replaced by the node's version without a conflict copy.
- **Pulled and published history.** Each history file is named `manifests/<16-digit sequence>-<cid>.enc`. A name is a claim:
  the pull trusts a prefix only after the entry authenticates and carries the same sequence. Entries written by an earlier
  development build, `<cid>.enc`, still read and sort before all prefixed names, with no order among themselves.

### Phone facts (measurements, not claims about the encrypted pull)

Recorded on 2026-10-02 from operator screenshots and reports on an iPhone (iOS 27.2 beta, Obsidian 1.13.7 build 365); no
agent reproduced them (`children/mobile-feasibility/device-results.md`):

| What | Result |
|---|---|
| Release 0.2.0 plaintext pull, 5 files, 24 KB | Worked |
| Release 0.2.0 plaintext pull, one 50 MB and one 5 MB random file | Worked (operator report; time and responsiveness not recorded) |
| Argon2id 64 MiB, t = 3, p = 1, probe build `0.2.1-probe.1`, three runs | 980, 1143 and 1133 ms; longest event-loop gap 21, 17 and 17 ms. The Mac baseline for the same function was 990 to 1177 ms |
| The first pull crashed the app once, then launches looped | The original crash is unexplained. The relaunch loop was an iOS file-provider hang (watchdog 0x8BADF00D), cleared by restarting the phone |

Not run: an encrypted publish or pull on a phone, background and suspend behaviour, memory above 50 MB, Android. A phone
test installs through BRAT from a GitHub pre-release with its own tag, never from a copy of the main tag's files. Until the
guard is removed in `mvp-07b`, a phone build is a fixture-only build.

### Refusals and stops during a pull

Every stop below writes nothing in the vault unless it says otherwise. Pull stops exit 1; refusals before a request exit 2.

| Message contains | Meaning | Action |
|---|---|---|
| `--allow-rollback needs an explicit target` / `--resolve-fork works only on a name target` / `--resolve-fork cannot be combined with --allow-rollback` | A flag combination the rules never accept | Fix the command |
| `this directory is not empty and has no .ipfs-sync-fixture marker` | The destination holds files and no marker | Use an empty directory, or write `fixture` or `pulled-fixture` into the marker if it holds no real notes |
| `the vault id is not the one expected by --expect-vault-id` | The slot file's vault is not the one you named | Check the root and the id; nothing was derived |
| `below the N required by --expect-min-sequence` | The node serves an older manifest than you required | Do not accept it; check the node |
| `records a different vault than the one being pulled` | This directory or this device's floor belongs to another vault | Use another directory, or check the root |
| `the node serves sequence N but this device has recorded sequence M` | Rollback or freeze by the node, or a restored backup | Do not pull. If you mean it, `--manifest` or `--root-cid` with `--allow-rollback` |
| `an unfinished publish of sequence N is pending; run publish` | This device's own publish was cut short | Run `publish` |
| `sequence N exists here with different content than this device recorded` | A fork | `pull --resolve-fork` for the name |
| `this directory has no record of this vault and this run cannot ask` | First pull without a terminal | Confirm at a prompt, or pass `--accept-first-pull` |
| `the first pull was declined` | You answered no | Nothing was written (the lock may have created `.ipfs-sync/`) |
| `manifest.enc on the node does not authenticate under this vault's key` | Forged, damaged or another vault's file | Do not retry blindly; check the node. No file was requested |
| `manifest.enc authenticated but holds something this build does not read` | A newer format, or limits above this build's | Update `ipfs-sync` |
| `the root holds key slots but manifest.enc is absent or unreadable on the node` | The manifest is withheld or not yet published | Wait, or check the node. The vault is treated as neither empty nor creatable |
| `no history entry under the root names that tree CID` / `more than one history entry names that tree CID` | `--manifest` found zero or several entries | Use `--list-versions`, or pull the root by `--root-cid` |
| `the sequence floor file is damaged` | `sequence-floor.json` or the plugin's `deviceStore` section does not decode | Delete it as the message says and pull again as a first pull; this resets every vault's floor on this device |
| `the local state file for this root cannot be read` | `state.<h>.json` is damaged or in an unsupported format. It holds this root's baseline | Do not edit it and do not delete `.ipfs-sync/`. This build has no command that repairs it |
| `another publish is running in this vault` | `publish.lock` is held (publish's own text) | Wait, or see "Locks" |
| `this pull needs N MiB, above the ceiling of M MiB, and was not confirmed` | A large pull without a yes | Run again with `--accept-large`, or raise `--max-bytes` |
| `wrong passphrase or damaged key slot` | The commitment or the wrap did not verify | Retry with the right passphrase |

## What to keep

| Keep | Why | Note |
|---|---|---|
| The passphrase | Only key to the vault | No recovery. A copy in a password manager |
| The MFS root name, the IPNS key ID | To find the vault again | The key ID is recorded under `ownedKeys` in the config file |
| `.ipfs-sync/keyslots.<h>.json` | The node's `keyslots.json`, byte for byte. Not secret | This build has no command that puts it back on the node. If the node loses the file, the tool stops with "the node no longer holds this vault's key slots" and does not generate a new key |
| Nothing from `.ipfs-sync/` in third-party sync | `state.<h>.json` and `journal.<h>.json` hold your file paths in plaintext, and `tmp/` can hold plaintext file content | Deleting the folder makes this device a stranger to the roots it published to; it can pull again as a first pull (the floor stays), and it cannot publish before it has |
| The per-user directory (CLI) or the plugin data (plugin) | `sequence-floor.json` and the device id live there, outside the vault | Deleting either removes the floor that detects a rollback. Reinstalling the plugin does the same |

## Refusals and what to do

Every refusal below sends nothing to the node or stops before anything is written unless it says otherwise.

### Marker, passphrase and vault existence

| Message contains | Meaning | Action |
|---|---|---|
| `publish refused: this vault has no .ipfs-sync-fixture marker` (or `marker is empty`, `marker says "pulled-fixture"`, `marker does not hold the text "fixture"`) | The guard. Real vaults are refused until `mvp-07b`. A marker left by release 0.2.0 pull (`fixture copy created by ipfs-sync pull`, empty, or `marker`) also lands here; `pull` says the marker predates this version, and `publish` says so only for the pulled-copy text | For a fixture vault, write `fixture` into `.ipfs-sync-fixture`. That is your statement that the directory holds no real notes; nothing verifies it |
| `publishing needs the vault passphrase and none was supplied` | No file, no variable, and no terminal | Set `IPFS_SYNC_PASSPHRASE_FILE`, or run on a terminal |
| `both IPFS_SYNC_PASSPHRASE and IPFS_SYNC_PASSPHRASE_FILE are set` | Two sources | Unset one |
| `not a valid generated passphrase` (`passphrase-format`) | Wrong length, characters outside `A-Z2-7`, or the check symbols do not match (a probable typo). The check catches about 99.9% of single mistyped body symbols; about 1 in 1,024 wrong strings still passes and then fails as a wrong passphrase | Copy the passphrase; letters are not case-sensitive and hyphens are optional |
| `wrong passphrase or damaged key slot` | The commitment or the wrap did not verify. One outcome by design. With a local copy the unlock happens locally, but `publish` sends two read-only requests (`files/stat`, `key/list`) before it unlocks; none mutates | Retry with the right passphrase. A node file that differs from this device's copy is reported separately, as a key-slot mismatch |
| `this MFS root holds no encrypted vault yet, and publish never creates one` | Empty root, no local copy | Run `ipfs-sync init` |
| `init` refuses: root already holds a vault, root not empty, or this device already holds a key-slot copy for the root | `init` creates only in an empty root, once | Use a new `--mfs-root` |
| `this MFS root holds a plaintext publication from an earlier release` | The root has a `manifest.json` or plaintext entries from release 0.2.0 | Use a new `--mfs-root`. The old plaintext stays public and pinned |
| `the MFS root holds entries that are not part of a vault` | Extra top-level entries | Remove them on the node yourself, or use a new root. The tool never deletes outside `current/` |

### Key slots and devices

| Message contains | Meaning | Action |
|---|---|---|
| `the node's key slots differ from this device's copy` / `differ from the recorded ones` (vault mismatch) | Someone replaced `keyslots.json`, or it was damaged. No derivation was run on the node's parameters | Do not retry with `--repair` (it is refused for this case). Check the node. If the vault is lost to you, use a new root and a new vault |
| `the node no longer holds this vault's key slots` | `keyslots.json` is gone from the node | The tool never generates a new key. This build has no command that restores the file. Use a new root and a new vault |
| `this device is not the publisher of the vault in this root` | The node holds a manifest and this device has no record and no copy (for example a second device, or after deleting `.ipfs-sync/`) | Nothing was derived. Run `ipfs-sync pull` (plugin: Pull) with the vault passphrase and the same MFS root; see "Second device" |
| `the root holds key slots but no manifest and this device knows nothing about it` | An interrupted first publish from elsewhere, or a lost record | Use a new root, or pass `--recover-slots` on a terminal: it shows the Argon2id cost and asks before it derives |
| `recovery was not confirmed` | You answered no, or there was no terminal | Rerun on a terminal |
| `key slot costs ... MiB, ... iterations, above the allowed ...; not approved` (`kdf-cost-refused`) | A slot on the node asks for more than 64 MiB and 3 iterations. A hostile file could ask for 128 MiB and 4 iterations, twice | Only accept if you created that vault with those parameters. A run with no terminal refuses |
| `kdf-params-out-of-bounds`, `unsupported-format` | The slot file is outside the floors and ceilings, or a version or algorithm this build does not know | Do not accept. Check the node |

### Sequence, journal and repair

`sequence` is the manifest counter. Each publish writes the next number.

| Message contains | Meaning | Action |
|---|---|---|
| `the node's manifest has sequence N, older than this device's record` (sequence-behind) | An older snapshot was put back on the node | If this device's record is the truth: `publish --repair` (publishes at local + 1, no prompt). Otherwise use a new root |
| `the node's manifest has sequence N and ... this device's record has sequence M` (sequence-ahead) | Another device published, or `.ipfs-sync/` was restored from a backup | `Run pull first, then publish again.` `--repair` refuses this case when a floor exists for the vault or this device has a usable state. It stays available only for a state file that exists and does not decode, with no floor; it then warns that changes by any other publisher will be discarded and asks first |
| `the node holds a different manifest at sequence N than this device published` (fork) | Another device published at the same time | `pull --resolve-fork`, then publish. `--repair` does not apply |
| `another device may have published to this vault while this publish was running` (overlapping-publish) | The publication name moved between this publish's start and its last check. Nothing was published; what it wrote to the node's tree stays, and its journal stays | Run pull, then publish again. The next pull sets the journal aside if the pulled manifest is at or above its sequence |
| `the publication name could not be read` (name-routing-failed) | Name routing did not answer in time, or answered an error this tool does not recognise, so an overlapping publish could not be ruled out | Check the node's network and publish again |
| `the node has no manifest.enc there now` / `manifest.enc is present but does not authenticate` | The node lost or damaged the manifest, or a write was cut short | If the node's `keyslots.json` is still this device's copy: `publish --repair` rewrites `manifest.enc` from this device's record after a warning and a confirmation. Otherwise a new root |
| `the interrupted publish was for sequence ...` / `record of the interrupted publish belongs to another ...` | A journal that the automatic resume will not finish | `publish --repair`. For a wrong `--key`, publish with the original key name |
| `the node already holds a different history file for this snapshot` | A file planted at this publish's own history name, `manifests/<16-digit sequence>-<rootCID>.enc` | Change any file in the vault and publish again; if it persists, a new root. A history file is never overwritten. A file planted at the name of an earlier sequence does not stop later publishes: each writes its own name |
| `--repair is not allowed here: <reason>` | The conditions are not met: the manifest does not authenticate, another vault, no copy of the slot file, the slot file differs, or no record of publishing to this root | Fix the named condition, or use a new root |
| `--repair was not confirmed` | You answered no, or there was no terminal | Rerun on a terminal |

`--repair` is allowed only when the node's manifest authenticates, belongs to this vault, and the node's `keyslots.json`
equals this device's copy byte for byte (except when it rewrites a missing or unreadable `manifest.enc`, where the slot
file must still match). The plugin does not have `--repair`.

### Locks

| Message contains | Meaning | Action |
|---|---|---|
| `another publish is running in this vault` | `.ipfs-sync/publish.lock` is held with a fresh heartbeat | Wait. If the holder is gone: `publish --break-lock` (asks first) |
| `the publish lock file ... cannot be read` | Damaged lock | `publish --break-lock` on a computer. The plugin cannot clear a lock file it cannot parse, because its age is unknown |
| `the publish lock was taken over, removed or could not be refreshed` | The lock lapsed while a publish ran; it stopped so two do not overlap | Rerun |
| `the publish lock needs hard links` | FAT or a network mount | Publish from a vault on a file system with hard links |

A lock is replaced automatically when the recorded process is gone from this host, or after 15 minutes without a
heartbeat on any host. The plugin's lock records no process ID, so a crashed plugin's lock waits for the 15 minutes,
`--break-lock`, or the plugin's "Clear stale publish lock". The lock is a best-effort guard, not an atomic lock across
machines.

**Clear stale publish lock (plugin).** Use it on a device with no command line, such as a phone, after a publish was
interrupted. It is a command ("Clear stale publish lock") and a button in the "Publish lock" section of the settings tab.
- It is offered only when the lock's last heartbeat is at least 15 minutes old. A fresh lock is reported as held and is
  not touched. The age and the lock's token are checked again when you confirm, and nothing is removed if they changed.
- It holds the plugin's in-process sync lock for its whole duration. If a publish, pull or abandon is already running in
  this plugin it reports busy and does nothing, and a publish started while it works is refused. This lock does not stop
  an `ipfs-sync publish` started from a command line on the same vault folder.
- It moves the lock file aside, checks what it moved, and discards it only if it is the lock it saw; otherwise it puts
  it back. If the plugin crashes between the move and the discard, a `.taken` file (a few bytes) stays in `.ipfs-sync/`.
  Nothing cleans it up automatically; delete it by hand.
- A lock file that is not a readable lock record has no known age, so the plugin will not clear it. Use
  `ipfs-sync publish --break-lock` on a computer.
- It removes only the lock file. No note and nothing on the node changes.
- This action has not been run inside Obsidian.

**Caution: `--break-lock` and a running plugin publish.** `--break-lock` removes the lock after you say yes. If a plugin
publish is running on the same vault folder at that moment, it deletes a live lock and two publishes can overlap. Run it
only when you know no publish is running on any device that uses the folder.

**How the plugin takes the lock.** It checks that `publish.lock` does not exist, then renames a fully written temporary
file onto it: two steps. After the rename it reads the file back and compares the bytes (`src/plugin/adapter-lock-file.ts`);
if the file is not its own it returns "not created" and leaves the other holder's file alone, and if the read-back
throws it removes its own file. A second check of the token (`src/sync/lock-token-check.ts`, shared with the CLI) runs
right after the lock is acquired and before the publish starts; a mismatch stops the publish with `lock-held`. Since
`mvp-07a` the engine also awaits a fresh check of the token right before its first request that can change the node
(resume, key creation or first blob, junk removal), in the CLI and the plugin. There is no check immediately before each
write to the node. After that, only the heartbeat (every 60 s) notices a replaced lock file, so on
a platform where rename overwrites an existing file, a CLI publish and a plugin publish can overlap for up to one
heartbeat interval (about 60 s). The plugin still depends on rename semantics for that window. What `adapter.rename`
does in Obsidian is unconfirmed, and the plugin lock has not been run in Obsidian.

### The node, the history, big uploads

| Message contains | Meaning | Action |
|---|---|---|
| `manifests/ on the node holds N history files ... warns` | 1,500 or more history files. Publishing continues | Plan a new root. `ipfs-sync prune-history` does not exist in this build |
| `manifests/ on the node already holds N history files ... stops at 1,999` | Publishing to this root is over | New MFS root, new vault (`init`), full re-upload, new passphrase. Removing old `manifests/<sequence>-<cid>.enc` entries by hand is untested and unsupported (and a pull's fork resolution then finds no common ancestor for them) |
| `manifests/ ... holds entries that are not history files` | Junk names | Remove them on the node, or `publish --repair` (asks first, removes one name at a time, nothing else) |
| `the folder current/<xx>/ ... holds more than 2,000 entries` | Something else wrote into the blob tree | Remove the extra entries on the node |
| `the node no longer holds N MiB of this vault's files as recorded` | Diagnosis found blobs missing; re-upload is over 256 MiB | `--allow-full-reupload`, or a yes at the prompt |
| `... is larger than the limit of N bytes and was not read` / `not what it should be (wrong kind or size)` | A hostile or damaged object on the node (`keyslots.json` over 16 KiB, `manifest.enc` over 64 MiB, and so on) | Do not accept. Check the node |
| `the node reports the vault tree with a CIDv0` | Unsupported | Report it; nothing was published |
| `a file changed while it was being read for upload` | The vault was being edited | Rerun when it is quiet |
| `a vault manifest ... written by a newer or incompatible version` | An authentic manifest this build does not understand | Update `ipfs-sync`. Nothing is overwritten |
| `the publication key ... is missing, or is not the key this publish verified` | The IPNS key changed under you | Check the key on the node and the key name |
| `read-back of the snapshot failed` | The snapshot on the node is not what was written | Nothing was pinned or published. Rerun. A repeat means someone is writing to the root |

### Before a shared-node run of `tools/feature-op-mvp-07a.mjs`

This run happened once, on 2026-10-03, against the shared node: exit 0, 76 of 76 checks passed, 1 skipped by design (replay by name is stub-only). The demo folder `musbpmtt-e574198f` was left on the node; cleanup is opt-in with `--cleanup`. These are the steps for any further run (condition from review 6.4, pass C, M-02).

If the key exists on the node but is not in the script's config file, the script needs `--owned-key <id>`. Without it, it refuses with exit 2 before any mutation.

1. Run a fresh `pnpm build` immediately before the run; the script checks that `dist` did not change during it.
2. Save the printed line `previous IPNS pointer of obsidian-vault-sync: <keyId> -> <pointer>` before the run proceeds. If the line is missing, stop. It is the only record of where the name pointed.
3. The run publishes three times to the key `obsidian-vault-sync`. Until you restore it, the real name points at the demo vault.
4. Do not publish the real vault with this key during the run, and do not rely on pulls by that name until you have restored it.
5. Restore by republishing the saved pointer to the same key. `ipfs-sync` has no command for this (`ipfs-sync --help` lists none, and `publish` always writes a new snapshot), so the script prints the kubo CLI form after the run: `ipfs name publish --key=obsidian-vault-sync /ipfs/<cid>`, with `<cid>` taken from the saved pointer line. Facts about this form:
   - Run it on the node, as a user with access to the node's keystore. It cannot be run from a device that only has the HTTP API behind a gateway.
   - It restores the saved pointer only, and only for the key `obsidian-vault-sync`.
   - Its record lifetime and TTL are kubo's defaults, not the product's 5-minute TTL. A resolver may see the restored value for a different length of time than after a product publish.
   - Verified once on 2026-10-03 against kubo v0.42.0 (pod `ipfs-0`), default lifetime and TTL only; not tested with other options. On a throwaway key it published (about 8 s) and `ipfs name resolve --nocache` returned the CID; a republish to another CID resolved to the new one; the key was removed. The real run's pointer was then restored with the same form and resolved to the saved pointer.
   - On this deployment the command runs via `kubectl --context know-me -n ipfs exec ipfs-0 -c ipfs -- ipfs name publish --key=obsidian-vault-sync /ipfs/<cid>`.
   - If the saved line is not a plain `/ipfs/<cid>` path, the script prints no command; restore it by hand from the saved line.
6. After a restore, resolve the name and compare it with the saved line.

Cases where there is nothing to restore:

- **No earlier pointer was recorded.** The script says so; the key points at the demo vault until the real vault publishes again.
- **accepted-unresolved.** The previous pointer is unknown and cannot be restored from the run. Do not pass `--accept-unresolved-pointer` unless you accept losing it. Not-found and timeout look the same on the node, so a pointer that exists but did not answer is lost the same way.

A Ctrl-C or other signal exit in the middle of the run may skip the post-run print. The line printed before the run (step 2) is the saved record; use it, not the post-run output.

## Abandon a vault on this device

Several refusals above end in "use a new root and a new vault". The step that makes this device forget the old root is
`abandon`:

```bash
ipfs-sync abandon <vault> --mfs-root <the root you are leaving>
```

- It shows the files it will move (`keyslots.<h>.json`, `state.<h>.json`, `journal.<h>.json` under `.ipfs-sync/`) and asks
  you to type `abandon`. It moves them to `.ipfs-sync/abandoned-<h>-<ms>/`. Nothing is deleted.
- It never contacts the node. The old vault, its pins and its history stay on the node.
- Without a terminal it does nothing unless you pass `--yes-abandon`. That flag replaces the typed word only; it does not
  skip the backup.
- If this device holds none of the three files for the root, it says so and moves nothing (check `--mfs-root`).
- It records the encrypted-seen latch (`.ipfs-sync/encrypted-seen.json`) before it moves anything. This keeps a later
  `pull --allow-plaintext-v1` from accepting a forged plaintext root for this destination. An `abandoned-<h>-<ms>` folder
  also counts as evidence of an encrypted vault (`ABANDONED_BACKUP` in `src/sync/pull-latch.ts`). The CLI has always
  listed directory names; the plugin's folder key-value store was corrected after review 5c to list matching folders,
  and that is covered by tests with a fake adapter only, not run in Obsidian. Deleting the whole `.ipfs-sync/` folder,
  backup included, still resets the latch.
- The CLI takes the cross-process publish lock while it moves files, and refuses if a publish holds it. The plugin does
  not: it takes only the in-process lock, which stops a publish, pull or timer run inside the same Obsidian, but not a
  `ipfs-sync publish` started from a command line on the same vault folder. Do not run one while you abandon from the
  plugin.
- Afterwards run `ipfs-sync init <vault> --mfs-root <new, empty root>`.
- In the plugin: the command "Abandon this vault", or the button in the Encryption section of the settings tab. The
  dialog asks for the same word. These dialogs have never been run inside Obsidian.

### Restore the backup

Abandon moves files; it does not delete them, so you can put them back while the old vault is still on the node. The
backup folder is `<vault>/.ipfs-sync/abandoned-<h>-<ms>/` (`<h>` is the first 16 hex characters of the SHA-256 of the MFS
root, `<ms>` the time of the abandon in milliseconds). Inside it, only the files that existed are present, named without
the `<h>`: `keyslots.json`, `state.json`, `journal.json`.

1. Make sure no publish is running on any device that uses this vault folder.
2. Move each file back into `<vault>/.ipfs-sync/` under its per-root name, using the same `<h>` as the folder name:
   `keyslots.json` to `keyslots.<h>.json`, `state.json` to `state.<h>.json`, `journal.json` to `journal.<h>.json`.
   Do not overwrite a file of the same name that a newer setup created; if one exists, you are mixing two vaults, so
   stop and decide which root you are keeping.
3. Use the same `--mfs-root` as before (the `<h>` in the names must match that root), then run `publish`. If the node
   moved on while the files were away, expect a sequence refusal and see "Sequence, journal and repair" above.
4. Restoring does not lower the encrypted-seen latch. That is intended: this destination has held an encrypted vault.

This procedure is written from the code (`abandonVault` in `src/sync/vault-keys.ts`); it has not been run by hand on a
real vault.

## Limits an operator should know

- No recovery for a lost passphrase. A passphrase change and a rewrap are not implemented; when they are, they will not
  revoke old passphrases or old slot copies.
- The key slot is public; the passphrase is the only protection against offline guessing.
- The node can see sizes, counts and timing, and can delete, replace, withhold or roll back. A pull detects a rollback
  only against the sequence this device already accepted (the floor and the state; see "The record and the sequence
  floor"), cannot detect a freeze, and has no baseline on a first pull.
- `requestUrl` in the plugin buffers whole response bodies; size caps do not protect its memory.
- A file restored with its old modification time and the same size is missed by the delta and idle checks. A pull trusts
  the same pair too: it can replace such a file without a conflict copy.
- Node has no `openat`: a swap of the passphrase file's parent directory between check and open can misplace the file.
- Windows has no POSIX mode check for the passphrase file.
- The plugin writes its local key-slot copy through Obsidian's adapter; that write is not crash-atomic (the CLI's is).
  Plugin setup writes only that local copy; the next publish writes `keyslots.json` to the node. The plugin cannot repair
  or recover slots for a vault; use the CLI.
- Release note: vault writes by the CLI now create directories 0700 and files 0600 through a temporary file. A crash can
  leave `.<name>.<pid>.<uuid>.tmp` inside a vault directory; delete it by hand.
- Nothing has run inside Obsidian. The key derivation was timed on an iPhone in a probe build (see "Phone facts"); an
  encrypted publish or pull has not run on a phone, and Android is untested.
- The feature-operation script `tools/feature-op-mvp-06.mjs` ran twice against the shared node on 2026-09-30, for task
  6.2 and for the delivery-cadence feature checkpoint. Both runs exited 0 with 121 of 121 checks; they are recorded in
  `.kbd-orchestrator/phases/mvp/decision-log.md`, and I did not re-run the script. What it asserted there: the encrypted layout; publish #2 "1 written, 0 removed" at sequence 2; listing of the
  immutable root; three kill points, each resumed; refusals that sent no mutating request; and that all 42 mutating
  requests stayed under `/obsidian-vault-sync/mvp06-demo/<runid>` and the script's own key. The hostile-object
  variants ran against a local stub only. Argon2id took 844, 1096 and 859 ms wall, with a largest event-loop gap of
  39 ms, on the development machine (not a phone).
  Consequences on the node: the two runs left two run folders under `/obsidian-vault-sync/mvp06-demo/`
  (`muo58t8n-ed2e9a64` and `muo6r3gr-8907bcc4`) and their pins. The runs repointed the IPNS key `obsidian-vault-sync`:
  it pointed at the mvp-05 plaintext demo root `/ipfs/bafybeihh4slp53ygsfk454pm4tqjbccd5tu6s6egu37gai2mvfnbw6aa7e`, then at the first run's root
  `/ipfs/bafybeiec4bfadcs3iaowvg4yiwh66ivnrn3sym4r6h4x4xtw262un5jxwu`, and now points at the second run's root
  `/ipfs/bafybeifu652yt23rpx4d4wgzd4rvyehf6xob6m53dzy6rntni2osl6oz3u`. No earlier pointer was restored; the other keys are unchanged. The script's `--cleanup` would not unpin the
  demo roots.
  Two points where the script's task wording and the delivered behaviour differ, and the behaviour is what the
  script asserts: `publish --repair` on an older genuine manifest (behind) succeeds without a prompt, and only the
  ahead and rebuild cases ask; the wrong-passphrase refusal sends two read-only requests (`files/stat`, `key/list`)
  and no mutating request.
  Still unverified against a real node: kubo `files/write` overwrite semantics beyond what that run exercised, and
  whether kubo reads `arg` from a POST body.
- The lock token is checked right before the first request that can change the node, not before each node write (review
  5c, C5-02, open for the "each write" case; the `mvp-07a` check at the first change has not been reviewed). See "How the
  plugin takes the lock".
- Accepted, cosmetic: after an abandon in the plugin, a second Publish can open a second unlock dialog over the first.
- The plugin's pull notice for a vault with other files says "no files outside .obsidian/ and .ipfs-sync/".
- The prompt restores the terminal after Ctrl-C, Ctrl-D and other tested paths only in tests with injected streams.
  Restore after `SIGTERM`, `SIGHUP` and `SIGTSTP` is unverified: if a terminal is left without echo, run `stty sane`.
- Reviews 0.1, 0.2, 2, 2b, 3, 3b, 4-1, 5, 5b and 5c are done; each was a static read by one model and the cross-model
  judge was not run. Review 5c re-read the review-5 fixes R5-01 to R5-08 statically with nothing executed. The
  corrections made for its findings (C5-01, C5-03, C5-04, C5-05) have not been re-read by a reviewer.
