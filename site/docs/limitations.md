---
title: Limitations and troubleshooting
description: The limits that stay, what is not verified, and what to do when the tool refuses — with a pointer to the operator runbook.
---

# Limitations and troubleshooting

These lists exist because they are the cases where the tool's checks can give a
false sense of safety. They are stated, not smoothed over.

## Limits that stay

<!-- source: README.md L928-944 -->

- **Removing 49 percent of the entries is silent.** The mass-removal guard
  stops a publish that would remove every remaining entry, or more than half of
  at least two — and not the first publish of a vault. Half and below proceed
  unasked. An unmounted vault folder looks like every file deleted and is
  caught; a half-mounted folder missing less than half the entries is not. The
  guard protects the publish, not the node: the node keeps every old root.
- **Silent per-file corruption of unchanged files by someone who can write to
  the node is not detected by the publisher.** The publisher does not re-read
  blobs it did not write in this run; a reader that decrypts one will notice.
- **Concurrent publishes are narrowed, not prevented.** kubo has no
  compare-and-swap. A publish re-reads the name before its first write and
  again before `name/publish` and refuses if it moved, but a write race on the
  shared tree is not detected at all.
- **The sequence floor does not stop a node from showing an old copy to a
  device that has no recorded state.** A first pull, a reinstalled plugin and a
  deleted per-user state directory all have no record, and a freeze (withheld
  updates) is never detected. Someone who holds the vault key can also publish
  a very high sequence that every device then records.
- **Rewrap does not revoke the old passphrase or any old copy of the key
  slot.** Only re-encrypting the vault under a new key would revoke, and
  nothing here does that.
- **A vault published by release 0.2.0 cannot be pulled by this version.** The
  plaintext reader is gone; a plaintext root is refused ("plaintext
  publications are no longer supported by this version", CLI exit 2). Use
  release 0.2.0 for those roots, and treat everything it published as public.

Further standing limits, with their mechanics:

<!-- source: README.md L326-442, L856-885 -->

- **History growth.** Every non-empty publish adds one encrypted history file
  to `manifests/`, pinned forever. The tool warns at 1,500 files and refuses at
  1,999, naming `ipfs-sync prune-history`; a folder above 2,000 entries cannot
  be listed and cannot be pruned — the way out is a new MFS root. An
  auto-publish timer at 15 minutes on a vault that changes every tick reaches
  the warning in about 15.6 days and the refusal in about 20.8 days unless you
  prune.
- **The desktop transport has no request timeout** (accepted backlog): a node
  that accepts the connection and then goes silent leaves the call pending.
- **The plugin's publish lock is best effort**, not an atomic lock across
  machines; a CLI publish and a plugin publish can overlap for up to one
  heartbeat interval (about 60 s) on a platform where rename overwrites.
- **A file whose size and modification time equal the recorded values is not
  read again.** A restore that preserves both (`cp -p`, `rsync -t`) is missed
  by the delta check until size or time changes.
- **The plugin cannot detect symbolic links** (Obsidian's file adapter has no
  `lstat`). The CLI refuses to write through a symlink; the plugin cannot make
  that check. Do not place symlinks in a vault you sync.
- **Large-file pull in the plugin is not advertised as working.** The plugin's
  transport buffers whole responses; a gateway that ignores the Range header
  makes large files `unfetched`.
- **This is not a backup.** A published snapshot is only as safe as your
  passphrase, the node and your own checks. Keep a separate backup.

## Not verified

<!-- source: README.md L962-986 -->

Nothing in this list has been checked, and none of it should be assumed to
work:

- any part of the plugin's encryption flow inside Obsidian — pull, restore,
  resolve fork, the key-management, mass-removal and cost dialogs, the measure
  command — beyond the recorded v0.3.0 operator run on desktop;
- the `keys` commands and `prune-history` against a real kubo node;
- an encrypted publish or pull on a phone; a High-cost key slot on a phone;
- Android, Windows and Linux;
- large binary bodies and Range requests through `requestUrl`, and large-file
  pull in the plugin;
- rollback prevention beyond what a device already accepted;
- an auth-protected kubo endpoint with the plugin;
- HKDF, HMAC and AES-GCM under Obsidian's WebView.

What was measured on an iPhone is on the [mobile setup](setup-mobile.md) page;
it covers old plaintext builds only. The full verification status of the
current release is on the [evidence](evidence.md) page.

## Troubleshooting: refusals and what to do

<!-- source: docs/operator/encrypted-vault.md L570-694 -->

The tool refuses loudly instead of guessing. Every refusal below sends nothing
to the node, or stops before anything is written. The authoritative mapping —
every refusal message, its meaning and its action — is the operator runbook
`docs/operator/encrypted-vault.md` in the repository ("Refusals and what to
do"); if a message on your screen differs from any doc, the code wins and the
doc is stale. The common cases:

| The message says | What it means | What to do |
|---|---|---|
| `publishing needs the vault passphrase and none was supplied` | No file, no variable, no terminal | Set `IPFS_SYNC_PASSPHRASE_FILE`, or run on a terminal |
| `both IPFS_SYNC_PASSPHRASE and IPFS_SYNC_PASSPHRASE_FILE are set` | Two passphrase sources | Unset one |
| `the passphrase file is inside the vault folder` | The next publish would upload it | Keep the file outside the vault |
| `unknown option --auth-password` (also `--auth-token`, `--auth-header-value`) | Credentials are never taken from the command line | Set the named `IPFS_SYNC_AUTH_*` environment variable |
| `the state folder is a symbolic link` | `<vault>/.ipfs-sync` is a link | Replace it with a real folder |
| `not a valid generated passphrase` | Wrong length or alphabet, or a probable typo | Copy the passphrase instead of retyping it |
| `wrong passphrase or damaged key slot` | The commitment or wrap did not verify; one outcome by design | Retry with the right passphrase |
| `this MFS root holds no encrypted vault yet` | Empty root, no local copy | Run `ipfs-sync init` |
| `this MFS root holds a plaintext publication from an earlier release` | Release 0.2.0 output | Use a new `--mfs-root`; the old plaintext stays public |
| `the node's key slots differ from this device's copy` | `keyslots.json` was replaced or damaged | Do not retry; check the node. If the vault is lost to you, a new root and a new vault |
| `the node no longer holds this vault's key slots` | The file is gone from the node | New root, new vault; `abandon` moves the local files aside first |
| `this device is not the publisher of the vault in this root` | Second device, or `.ipfs-sync/` was deleted | Run `pull` with the passphrase and the same MFS root |
| `the node's manifest has sequence N, older than this device's record` | An older snapshot was put back | If this device's record is the truth: `publish --repair` |
| `... sequence N ... this device's record has sequence M` (ahead) | Another device published | Run `pull` first, then publish again |
| `the node holds a different manifest at sequence N` (fork) | Two devices published the same sequence | `pull --resolve-fork`, then publish |
| `another publish is running in this vault` | `publish.lock` is held with a fresh heartbeat | Wait; if the holder is gone, `publish --break-lock` |
| `this publish would remove N of M entries` | The mass-removal guard | Check the vault folder is mounted and complete; if intended, `--allow-mass-removal` |
| `plaintext publications are no longer supported by this version` | A release 0.2.0 root | Nothing reads it; use a new MFS root |
| `manifests/ ... already holds N history files ... stops at 1,999` | History limit | `ipfs-sync prune-history <vault> --keep <n>` |
| `did not finish on this device, so publish and pull are paused` | A pending rewrap or prune journal | Run the same `keys`/`prune-history` command again; `keys discard` if it cannot finish |
| `needs a terminal to confirm` | No terminal and no confirming flag | Run on a terminal, or pass the flag the message names |

After a crash, a killed process or a dropped connection: run the same command
again. Do not delete `.ipfs-sync/`. When a refusal ends in "use a new root and
a new vault", `ipfs-sync abandon <vault>` (or the plugin's "Abandon this
vault") moves this device's local files aside — read its preview first: a
pending rewrap or prune is dropped, and its write to the node is not withdrawn.
