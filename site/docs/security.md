---
title: Security
description: The threat model as it stands — what is encrypted, what the node operator sees, public key slots and offline guessing, and the open-RPC warning.
---

# Security

This page normalizes the threat model from `DESIGN.md` section 8 and the
README's security section. The encryption is implemented; it has had static
reads by models, and **no independent review by a human or an outside party is
recorded**. Read the [limitations](limitations.md) page with this one.

## What is encrypted, and what is not

<!-- source: README.md L557-578; DESIGN.md §8.5 -->

File contents, file paths and names, and the manifest are encrypted
(AES-256-GCM) under a random 256-bit vault key. The vault key is stored on the
node in `keyslots.json`, wrapped by a key derived from your passphrase with
Argon2id (64 MiB, 3 iterations by default; a High preset of 128 MiB and 4
iterations exists).

What the node operator — or anyone who can write to the node — can still see:

- the number of files and the **exact size of each file** (a blob's length is
  its plaintext length plus a fixed overhead, so a file of known length is
  recognisable);
- when you publish and how often, and which encrypted blobs change;
- that the vault exists, plus the IPNS and gateway access pattern.

Such an operator can also delete, corrupt, replace or withhold any object, and
can serve you an older valid snapshot. A pull refuses a sequence below the
highest one this device recorded — which catches a replay only on a device that
already accepted a newer one; a freeze (withheld updates) is not detected.

Without the passphrase, and short of guessing it, the operator cannot read
names, paths, contents or the manifest, cannot create content that
authenticates under the vault key, and cannot make a publisher encrypt under a
different key.

## The key slot is public, forever

<!-- source: README.md L568-578; DESIGN.md §8.5 -->

Anyone who has a root CID can download `keyslots.json` and guess passphrases
offline, at the cost of Argon2id, **with no deadline**. Every old root stays
pinned on the node and this project never unpins one, so a leaked passphrase
plus any old copy of the slot — including the copies inside earlier pinned
roots — opens every state you ever published.

That is why passphrases are generated, not chosen: 23 random symbols (115 bits)
plus 2 check symbols from the RFC 4648 base32 alphabet. The check symbols are a
typo guard, not a proof of randomness: they catch a mistyped body symbol with
about 99.9% probability and a mistyped check symbol always, and about 1 in
1,024 arbitrary 25-symbol strings passes by chance.

**A passphrase change revokes nothing.** `keys change-passphrase` and
`keys increase-cost` write a new slot around the same vault key; nothing is
re-encrypted, and every old copy of the slot keeps opening the vault. Only
re-encrypting under a new vault key would revoke access, and no code here does
that.

**There is no recovery.** Lose the passphrase and every copy of the key slots
and the data is gone; nobody can reset it. The local copy of `keyslots.json`
protects only against the node losing the file. Save the generated passphrase
in a password manager before you publish.

## The open-RPC warning

<!-- source: README.md L1019-1038 -->

The maintainer's own test node — the host that releases up to 0.2.0 built in as
the default — accepted **unauthenticated writes from the entire internet** when
last checked, and that is not closed. It is no longer a default precisely
because a default would have sent every fresh install's encrypted blobs and
their metadata to a node anyone can write to. It remains the maintainer's
verification target only, and it hosts other projects' keys. **Never point a
real vault at it.**

If you configure a node that is open the same way, the same exposure applies to
you: anyone can add or pin garbage, create IPNS keys, or republish your vault
pointer if they learn its key name. Before a node becomes your sync backbone,
put auth in front of the RPC (basic-auth or a bearer token at a proxy) or
restrict `/api/v0` to your own IPs/VPN — and keep the RPC private long-term,
exposing only a read-only gateway. With an encrypted vault on a hardened node,
your notes are protected by the passphrase and by nothing else on the node: the
node can still delete, replace or withhold objects, and see sizes and timing.

## Plaintext local state

<!-- source: README.md L887-905; DESIGN.md §8.5 -->

Encryption protects what is on the node. Your notes sit in clear in the vault
folder on every device. `<vault>/.ipfs-sync/` holds your file paths in
plaintext, and its `tmp/` folder holds verified plaintext file content while a
pull runs and after a crash. The plugin's `data.json` stores node and gateway
credentials in plain text (it is never published; the whole `.obsidian/`
folder is excluded). Keep `.ipfs-sync/` out of iCloud, Dropbox, Syncthing,
backup tools and any repository. The sequence floor lives outside the vault —
in a per-user directory for the CLI, in the plugin data for the plugin — so
deleting the folder does not reset it.

## Redirects

<!-- source: README.md L371-399; DESIGN.md §8.7 -->

A 301, 302, 303, 307 or 308 answer is refused on the shared request path with a
fixed message; the `Location` is not shown and not followed. On **desktop**
that refusal holds: requests go through Node's `http`/`https`, which return the
3xx instead of following it, so a credential goes to the configured URL only.
On **mobile it cannot hold**: Obsidian's `requestUrl` follows redirects itself,
with no option to stop it and no way to read the final URL. **On iOS the plugin
cannot stop a custom-header credential (for example `X-Api-Key`) from reaching
another origin.** Use Bearer or Basic on a phone — iOS strips those on a
cross-origin hop. The redirect guarantee exists only where Node's `http` is
reachable; no setting adds it on mobile. Point the plugin only at an endpoint
you control and trust not to redirect.

## Passphrase handling in practice

<!-- source: README.md L646-688 -->

- `publish` and `pull` read the passphrase from exactly one of
  `IPFS_SYNC_PASSPHRASE_FILE` (a 0600 file you own), `IPFS_SYNC_PASSPHRASE`, or
  a non-echoing prompt. Setting both variables is an error; whatever you supply
  is checked for the generated form before any request is sent.
- An environment variable stays readable by your other processes, is inherited
  by child processes, and can land in shell history and CI logs. Prefer the
  prompt for interactive work and the 0600 file for automation.
- The interactive `init` display leaves the passphrase in terminal scrollback
  and in `script`/`tmux` logs.
- The CLI overwrites the passphrase bytes it holds after key derivation on a
  best-effort basis; strings cannot be overwritten, and the plugin's dialog
  holds the passphrase in an interface string that cannot be zeroed.

## What this does not provide

<!-- source: DESIGN.md §8.5 non-goals -->

Forward secrecy or revocation (the vault key never rotates); hiding file
counts, sizes, timing or the vault's existence; detection of a freeze or of a
stale first pull; protection for a device whose memory, environment or files
are compromised; deletion of history (old roots stay pinned); recovery of a
lost passphrase; device pairing and additional key slots (designed, not built —
see the [roadmap](roadmap.md)); and hiding or encrypting the local state.
