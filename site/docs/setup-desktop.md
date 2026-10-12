---
title: Desktop setup
description: Install the Obsidian plugin from a GitHub release or from source, install the CLI, create an encrypted vault with init, and configure the settings tab.
---

# Desktop setup

<!-- source: README.md L7-9 -->

**There is no default node.** Nothing works until you enter the RPC URL and the
gateway URL of a kubo node you run or trust, in the plugin's settings tab or
the CLI's flags, environment or config file. With either one missing, every
command refuses and sends no request.

## Before anything else: harden the node

<!-- source: README.md L1019-1038 -->

The node is your sync backbone; treat its RPC endpoint as write access to your
vault's pointer. The maintainer's own test node accepted **unauthenticated
writes from the entire internet** when last checked; it is not a default and
you should never point a real vault at it. Before you configure any node for
real notes:

- put auth in front of the RPC (for example basic-auth or a bearer token at a
  reverse proxy), and configure the same credential in the plugin settings or
  the CLI environment; or
- restrict the RPC endpoint (`/api/v0`) to your own IPs or VPN.

Long-term, keep the RPC private and expose only a read-only gateway for
content. Details: [Security](security.md).

## Install the plugin

<!-- source: README.md L87-101; manifest.json -->

Requires Obsidian 1.12.3 or later (`minAppVersion` in `manifest.json`).

**From the GitHub release.** Download `main.js` and `manifest.json` from the
release assets (v0.4.0 is a pre-release), copy both into
`<vault>/.obsidian/plugins/ipfs-sync/`, then enable **IPFS Sync** under
**Settings → Community Plugins**.

**From source.** Requires Node >= 24.15 and pnpm:

```bash
pnpm install && pnpm build
```

`pnpm build` writes the plugin to `dist/plugin/` (`main.js` and
`manifest.json`) and the CLI to `dist/cli/ipfs-sync.mjs`. Copy the two plugin
files into `<vault>/.obsidian/plugins/ipfs-sync/` as above. For development,
`pnpm dev` watches and rebuilds; with `OBSIDIAN_PLUGIN_DIR` set it writes
straight into that plugin directory — note that this overwrites those files on
every rebuild, so never point it at a vault you do not want overwritten.

## Install and run the CLI

<!-- source: README.md L444-489; cli/help-text.ts L4-22 -->

The CLI is a plain Node HTTP client against the kubo RPC and gateway; it needs
no local IPFS daemon. Build once, then run it directly or through the
`ipfs-sync` bin:

```bash
node dist/cli/ipfs-sync.mjs status
```

`status` is a safe first command: it shows node identity, the MFS listing, a
gateway fetch, a write probe and key state. Endpoints come from flags
(`--rpc-url`, `--gateway-url`), the environment (`IPFS_SYNC_RPC_URL`,
`IPFS_SYNC_GATEWAY_URL`) or the config file (`rpc.url`, `gateway.url`).
Credentials come from the environment only — never the command line. The full
surface is in the [CLI reference](cli-reference.md).

## Create the encrypted vault: `ipfs-sync init`

<!-- source: README.md L626-688; cli/help-text.ts L26-37 -->

`init` is the only command that creates an encrypted vault; `publish` never
creates one. It needs an MFS root strictly below `/obsidian-vault-sync` that is
completely empty on the node:

```bash
node dist/cli/ipfs-sync.mjs init <vault> --mfs-root /obsidian-vault-sync/<name>
```

`init` generates the passphrase itself — 25 characters shown as five groups of
five. You cannot choose your own. Two ways to receive it:

- **Interactive** (default on a terminal): it prints the passphrase once and
  asks you to type it again. What it printed stays in your terminal scrollback
  and in `script`/`tmux` logs — clear or disable those first, or use the file
  form.
- **Automated**: `--passphrase-file <path>` writes the passphrase to a new
  file (mode 0600, created exclusively) and prints only the path.

Save the passphrase in a password manager before you publish. **A lost
passphrase means the data is lost for good — there is no recovery.** Later
`publish` and `pull` runs take the passphrase from `IPFS_SYNC_PASSPHRASE_FILE`,
from `IPFS_SYNC_PASSPHRASE`, or from a prompt that does not echo. A passphrase
file inside the vault is refused, because the next publish would upload it with
the notes it protects.

Then publish:

```bash
IPFS_SYNC_PASSPHRASE_FILE=<path> node dist/cli/ipfs-sync.mjs publish <vault> --mfs-root /obsidian-vault-sync/<name>
```

## The settings tab essentials

<!-- source: README.md L105-234 -->

Open **Settings → IPFS Sync**. Until both the RPC and gateway URLs are set the
tab shows "Not configured", and publish, pull, status and the key actions
refuse with "Set your IPFS node in settings" and send no request. The
essentials:

- **RPC and gateway endpoints** — URL plus optional port each. The gateway URL
  is never derived from the RPC URL.
- **Authentication** — none, basic, bearer or a custom header, per endpoint.
  The gateway inherits the node credential only when both share an origin; an
  explicit **Gateway authentication** choice always wins. Credentials are
  stored in plain text in the plugin's `data.json`.
- **Publication key name and MFS root** — the IPNS key and the staging root the
  vault publishes under.
- **Encryption section** — vault state (not set up, locked or unlocked), the
  Lock/Unlock/Set up buttons, the pull record, key-derivation cost, and the
  key-management and prune-history rows.
- **Read cap** — the largest single file the plugin reads into memory (default
  64 MB); a file above the cap is counted as failed and the rest continue.
- **Ask before pulling more than (MB)** — the pull confirmation threshold
  (default 512 MB).
- **Auto-publish interval** (whole minutes, 0 = off) and **catch-up on load**
  (one pull after startup; off by default).

Commands (`Ctrl/Cmd+P`): **IPFS Sync: Publish vault**, **Pull vault**,
**Restore an older version**, **Resolve fork**, **Show status** and **Measure
key derivation time**. Two ribbon icons run Publish and Pull. The first Publish
on a device with no vault opens the setup dialog, which shows the generated
passphrase once and asks you to save it and type it again; the unlocked key is
held in memory only, never in `data.json`.

<!-- source: README.md L161-166 -->

If you upgrade from a build that had a built-in node: that host is retired and
open to anyone, so saved settings that name it are cleared at load and the
credential tied to them is dropped. You must enter your node's URLs and
credentials yourself.
