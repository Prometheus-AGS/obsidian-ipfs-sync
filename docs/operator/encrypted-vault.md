# Operator runbook: the encrypted vault

Audience: the person running `ipfs-sync` against a kubo node. Scope: `init`, `publish` and the plugin's Publish for
the encrypted publish path of change `mvp-06`. Status: fixture vaults only, encryption implemented but not
independently reviewed to the standard real notes need and never run inside Obsidian. The feature-operation script ran
twice against the shared node on 2026-09-30 (below); the plugin flow has not (`README.md`, `DESIGN.md` section 8). Pulling an encrypted vault does not exist yet.

The refusal texts below are quoted in part from the code (`src/sync/publish-refusals.ts`, `src/sync/vault-keys.ts`,
`src/core/config/node-safety.ts`). If a message on your screen differs, the code wins and this file is stale.

## Before you start

| Need | Detail |
|---|---|
| A fixture vault | `.ipfs-sync-fixture` at the vault root holding the text `fixture`. `pnpm fixture:generate <dir>` writes one. Anyone who can create the file can override this guard; it is not a control |
| An MFS root | `--mfs-root /obsidian-vault-sync/<name>`, strictly below `/obsidian-vault-sync`. One root per vault. `init` needs it completely empty |
| A place to keep the passphrase | A password manager. There is no recovery |
| Local storage that is not synchronised | `<vault>/.ipfs-sync/` is plaintext (paths). Keep it out of iCloud, Dropbox, Syncthing and backups |

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

Passphrase sources for `publish` (exactly one): `IPFS_SYNC_PASSPHRASE_FILE`, `IPFS_SYNC_PASSPHRASE`, or the prompt.
Setting both variables is an error. An environment variable is readable by your other processes and inherited by child
processes; prefer the prompt for interactive use and the file for automation.

## What to keep

| Keep | Why | Note |
|---|---|---|
| The passphrase | Only key to the vault | No recovery. A copy in a password manager |
| The MFS root name, the IPNS key ID | To find the vault again | The key ID is recorded under `ownedKeys` in the config file |
| `.ipfs-sync/keyslots.<h>.json` | The node's `keyslots.json`, byte for byte. Not secret | This build has no command that puts it back on the node. If the node loses the file, the tool stops with "the node no longer holds this vault's key slots" and does not generate a new key |
| Nothing from `.ipfs-sync/` in third-party sync | `state.<h>.json` and `journal.<h>.json` hold your file paths in plaintext | Deleting the folder makes this device a stranger to the roots it published to |

## Refusals and what to do

Every refusal below sends nothing to the node or stops before anything is written unless it says otherwise.

### Marker, passphrase and vault existence

| Message contains | Meaning | Action |
|---|---|---|
| `publish refused: this vault has no .ipfs-sync-fixture marker` (or `marker is empty`, `marker says "pulled-fixture"`, `marker does not hold the text "fixture"`) | The guard. Real vaults are refused until `mvp-07`. A marker left by release 0.2.0 pull (`fixture copy created by ipfs-sync pull`, empty, or `marker`) also lands here; `pull` says the marker predates this version, and `publish` says so only for the pulled-copy text | For a fixture vault, write `fixture` into `.ipfs-sync-fixture`. That is your statement that the directory holds no real notes; nothing verifies it |
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
| `this device is not the publisher of the vault in this root` | The node holds a manifest and this device has no record and no copy (for example after deleting `.ipfs-sync/`) | Nothing was derived. This build cannot pull an encrypted vault. Use a new root and a new vault |
| `the root holds key slots but no manifest and this device knows nothing about it` | An interrupted first publish from elsewhere, or a lost record | Use a new root, or pass `--recover-slots` on a terminal: it shows the Argon2id cost and asks before it derives |
| `recovery was not confirmed` | You answered no, or there was no terminal | Rerun on a terminal |
| `key slot costs ... MiB, ... iterations, above the allowed ...; not approved` (`kdf-cost-refused`) | A slot on the node asks for more than 64 MiB and 3 iterations. A hostile file could ask for 128 MiB and 4 iterations, twice | Only accept if you created that vault with those parameters. A run with no terminal refuses |
| `kdf-params-out-of-bounds`, `unsupported-format` | The slot file is outside the floors and ceilings, or a version or algorithm this build does not know | Do not accept. Check the node |

### Sequence, journal and repair

`sequence` is the manifest counter. Each publish writes the next number.

| Message contains | Meaning | Action |
|---|---|---|
| `the node's manifest has sequence N, older than this device's record` (sequence-behind) | An older snapshot was put back on the node | If this device's record is the truth: `publish --repair` (publishes at local + 1, no prompt). Otherwise use a new root |
| `the node's manifest has sequence N and ... this device's record has sequence M` (sequence-ahead) | Another device published, or `.ipfs-sync/` was restored from a backup | If you restored a backup: `publish --repair`. It warns that changes by any other publisher will be discarded and asks first. Two devices on one root are not supported |
| `the node holds a different manifest at sequence N than this device published` (fork) | Another publisher wrote to this root | `--repair` does not apply. Use a new root |
| `the node has no manifest.enc there now` / `manifest.enc is present but does not authenticate` | The node lost or damaged the manifest, or a write was cut short | If the node's `keyslots.json` is still this device's copy: `publish --repair` rewrites `manifest.enc` from this device's record after a warning and a confirmation. Otherwise a new root |
| `the interrupted publish was for sequence ...` / `record of the interrupted publish belongs to another ...` | A journal that the automatic resume will not finish | `publish --repair`. For a wrong `--key`, publish with the original key name |
| `the node already holds a different history file for this snapshot` | A file planted at `manifests/<rootCID>.enc` | Change any file in the vault and publish again; if it persists, a new root. A history file is never overwritten |
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
throws it removes its own file. A second check of the token (`src/plugin/lock-token-check.ts`) runs right after the
lock is acquired and before the publish starts; a mismatch stops the publish with `lock-held`. There is no check
immediately before each write to the node. After that, only the heartbeat (every 60 s) notices a replaced lock file, so on
a platform where rename overwrites an existing file, a CLI publish and a plugin publish can overlap for up to one
heartbeat interval (about 60 s). The plugin still depends on rename semantics for that window. What `adapter.rename`
does in Obsidian is unconfirmed, and the plugin lock has not been run in Obsidian.

### The node, the history, big uploads

| Message contains | Meaning | Action |
|---|---|---|
| `manifests/ on the node holds N history files ... warns` | 1,500 or more history files. Publishing continues | Plan a new root. `ipfs-sync prune-history` does not exist in this build |
| `manifests/ on the node already holds N history files ... stops at 1,999` | Publishing to this root is over | New MFS root, new vault (`init`), full re-upload, new passphrase. Removing old `manifests/<cid>.enc` entries by hand is untested and unsupported |
| `manifests/ ... holds entries that are not history files` | Junk names | Remove them on the node, or `publish --repair` (asks first, removes one name at a time, nothing else) |
| `the folder current/<xx>/ ... holds more than 2,000 entries` | Something else wrote into the blob tree | Remove the extra entries on the node |
| `the node no longer holds N MiB of this vault's files as recorded` | Diagnosis found blobs missing; re-upload is over 256 MiB | `--allow-full-reupload`, or a yes at the prompt |
| `... is larger than the limit of N bytes and was not read` / `not what it should be (wrong kind or size)` | A hostile or damaged object on the node (`keyslots.json` over 16 KiB, `manifest.enc` over 64 MiB, and so on) | Do not accept. Check the node |
| `the node reports the vault tree with a CIDv0` | Unsupported | Report it; nothing was published |
| `a file changed while it was being read for upload` | The vault was being edited | Rerun when it is quiet |
| `a vault manifest ... written by a newer or incompatible version` | An authentic manifest this build does not understand | Update `ipfs-sync`. Nothing is overwritten |
| `the publication key ... is missing, or is not the key this publish verified` | The IPNS key changed under you | Check the key on the node and the key name |
| `read-back of the snapshot failed` | The snapshot on the node is not what was written | Nothing was pinned or published. Rerun. A repeat means someone is writing to the root |

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
- The node can see sizes, counts and timing, and can delete, replace, withhold or roll back. This build does not detect
  a rollback.
- `requestUrl` in the plugin buffers whole response bodies; size caps do not protect its memory.
- A file restored with its old modification time and the same size is missed by the delta and idle checks.
- Node has no `openat`: a swap of the passphrase file's parent directory between check and open can misplace the file.
- Windows has no POSIX mode check for the passphrase file.
- The plugin writes its local key-slot copy through Obsidian's adapter; that write is not crash-atomic (the CLI's is).
  Plugin setup writes only that local copy; the next publish writes `keyslots.json` to the node. The plugin cannot repair
  or recover slots for a vault; use the CLI.
- Release note: vault writes by the CLI now create directories 0700 and files 0600 through a temporary file. A crash can
  leave `.<name>.<pid>.<uuid>.tmp` inside a vault directory; delete it by hand.
- Nothing has run inside Obsidian, and the key derivation has not been timed on a phone.
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
- The plugin's lock token is not re-checked immediately before each node write (review 5c, C5-02, open). See "How the
  plugin takes the lock".
- Accepted, cosmetic: after an abandon in the plugin, a second Publish can open a second unlock dialog over the first.
- The plugin's pull notice for a vault with other files says "no files outside .obsidian/ and .ipfs-sync/".
- The prompt restores the terminal after Ctrl-C, Ctrl-D and other tested paths only in tests with injected streams.
  Restore after `SIGTERM`, `SIGHUP` and `SIGTSTP` is unverified: if a terminal is left without echo, run `stty sane`.
- Reviews 0.1, 0.2, 2, 2b, 3, 3b, 4-1, 5, 5b and 5c are done; each was a static read by one model and the cross-model
  judge was not run. Review 5c re-read the review-5 fixes R5-01 to R5-08 statically with nothing executed. The
  corrections made for its findings (C5-01, C5-03, C5-04, C5-05) have not been re-read by a reviewer.
