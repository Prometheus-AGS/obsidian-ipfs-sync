---
title: CLI reference
description: Every ipfs-sync command, its flags, the environment variables, config precedence and exit codes — checked against cli/help-text.ts and cli/args.ts.
---

# CLI reference

<!-- source: cli/help-text.ts; cli/args.ts; README.md L444-548 -->

The CLI is a plain Node HTTP client against the kubo RPC and gateway — no local
IPFS daemon. Requires Node >= 24.15. Build with `pnpm install && pnpm build`,
then run `node dist/cli/ipfs-sync.mjs ...` or the `ipfs-sync` bin. Everything
below is also in `ipfs-sync --help`.

## Commands

```bash
ipfs-sync status
ipfs-sync init <vault> [--passphrase-file <path>]
ipfs-sync publish <vault> [--repair] [--recover-slots] [--break-lock]
    [--allow-full-reupload] [--allow-mass-removal]
ipfs-sync pull <vault> [--name <ipns-id>] [--root-cid <cid> | --manifest <cid>]
    [--allow-rollback | --resolve-fork] [--expect-min-sequence <n>] [--expect-vault-id <id>]
    [--accept-first-pull] [--accept-replace] [--max-bytes <n>] [--accept-large]
ipfs-sync pull <vault> --list-versions
ipfs-sync keys change-passphrase <vault> [--cost standard|high] [--passphrase-file <path>]
    [--accept-no-revocation] [--allow-downgrade]
ipfs-sync keys increase-cost <vault> --cost standard|high [--accept-no-revocation]
ipfs-sync keys accept-slots <vault> [--name <id> | --root-cid <cid> [--allow-rollback]] [--allow-downgrade]
ipfs-sync keys discard <vault> [--yes-discard]
ipfs-sync prune-history <vault> --keep <n> [--dry-run | --yes-prune]
ipfs-sync abandon <vault> [--yes-abandon]
ipfs-sync history [--limit <n>]
```

<!-- source: cli/help-text.ts L24-144 -->

- **status** — node identity, MFS listing, gateway fetch, write probe and key
  state.
- **init** — the only command that creates an encrypted vault: generates the
  passphrase (25 characters, five groups of five; never one you choose) and the
  key slots. See [desktop setup](setup-desktop.md#create-the-encrypted-vault-ipfs-sync-init).
- **publish** — encrypt and send only changed files to the node's MFS, then
  publish the snapshot to the IPNS key. Needs the vault passphrase and an MFS
  root strictly below `/obsidian-vault-sync`; never creates a vault.
- **pull** — fetch only files whose sha256 differs, from an encrypted root.
  Authenticates the manifest, checks the sequence against this device's record,
  writes only verified files, keeps local edits as dated conflict copies and
  never applies remote deletions. A plaintext (release 0.2.0) root is refused.
- **keys change-passphrase** — replace the key slot under a new generated
  passphrase, wrapping the same vault key. Revokes nothing (see
  [Security](security.md)).
- **keys increase-cost** — rewrap under the same passphrase at a higher
  Argon2id cost (`--cost standard|high` required).
- **keys accept-slots** — adopt the node's current key-slot file after another
  device rewrapped. Pulls no files and does not raise the sequence floor; run
  `pull` afterwards.
- **keys discard** — drop an unfinished key-management operation (rewrap or
  prune) this device cannot finish.
- **prune-history** — remove the oldest history files from the node's
  `manifests/` so that `--keep <n>` remain (at least the newest 20 are kept
  whatever `--keep` says), then republish the root under the same sequence.
- **abandon** — move this device's local files for a root (key-slot copy,
  state, publish journal, key-management journal) into an
  `abandoned-<h>-<ms>/` backup folder. Never contacts the node and deletes
  nothing; needs neither the RPC nor the gateway URL.
- **history** — print this device's own sync operations from the per-user
  on-disk log, newest first. Reads only, sends no request. Not to be confused
  with `prune-history`, which mutates the node.

## Global flags

<!-- source: cli/help-text.ts L146-222 -->

- `--config <path>` — config file (default `./ipfs-sync.config.json` if
  present; endpoints and non-secret fields only).
- `--rpc-url <url>`, `--rpc-port <port>` — RPC (write) endpoint. Required.
- `--gateway-url <url>`, `--gateway-port <port>` — gateway (read) endpoint.
  Required; it is never derived from the RPC URL.
- `--mfs-root <path>` — default `/obsidian-vault-sync/default`; publish needs a
  root strictly below `/obsidian-vault-sync`.
- `--key <name>` — IPNS publication key name (default `obsidian-vault-sync`;
  must match `^obsidian-vault(-[a-z0-9-]+)?$`).
- `--owned-key <id>` — an IPNS key ID this installation owns (repeatable; for
  this run only, never written to the config file).
- `--auth <scheme>` (`none | basic | bearer | header`), `--auth-user <user>`,
  `--auth-header-name <name>` — endpoint authentication.
- `--passphrase-file <path>` — for `init` and `keys change-passphrase`: write
  the generated passphrase to this new file (0600). There is no `--passphrase`
  option.
- `--show-request` — print each request (method, URL, headers) with credential
  headers redacted.
- `-h`, `--help`.

Command-specific flags: `--repair`, `--recover-slots`, `--break-lock`,
`--allow-full-reupload`, `--allow-mass-removal` (publish); `--name`,
`--root-cid`, `--manifest`, `--allow-rollback`, `--resolve-fork`,
`--expect-min-sequence`, `--expect-vault-id`, `--accept-first-pull`,
`--accept-replace`, `--max-bytes`, `--accept-large`, `--list-versions` (pull);
`--cost`, `--accept-no-revocation`, `--allow-downgrade` (keys); `--keep`,
`--dry-run`, `--yes-prune` (prune-history); `--yes-discard` (keys discard);
`--yes-abandon` (abandon); `--limit` (history).

## Environment variables

<!-- source: cli/help-text.ts L224-240 -->

```bash
IPFS_SYNC_RPC_URL, IPFS_SYNC_RPC_PORT, IPFS_SYNC_GATEWAY_URL, IPFS_SYNC_GATEWAY_PORT,
IPFS_SYNC_MFS_ROOT, IPFS_SYNC_KEY
IPFS_SYNC_AUTH_SCHEME, IPFS_SYNC_AUTH_USER, IPFS_SYNC_AUTH_PASSWORD,
IPFS_SYNC_AUTH_TOKEN, IPFS_SYNC_AUTH_HEADER_NAME, IPFS_SYNC_AUTH_HEADER_VALUE
IPFS_SYNC_RPC_AUTH_* / IPFS_SYNC_GATEWAY_AUTH_*   # per-endpoint overrides, same suffixes
IPFS_SYNC_PASSPHRASE_FILE, IPFS_SYNC_PASSPHRASE   # the vault passphrase; set at most one
IPFS_SYNC_DEVICE                                  # device name recorded in the manifest
```

**Config precedence: flag > environment > config file > defaults.**

## Credentials never come from the command line

<!-- source: cli/args.ts L177-206; README.md L497-507 -->

`--auth-password`, `--auth-token` and `--auth-header-value` do not exist; they
are refused by name with exit 2, because the process list and shell history
would show the value. The refusal names the replacement environment variable
(`IPFS_SYNC_AUTH_PASSWORD`, `IPFS_SYNC_AUTH_TOKEN`,
`IPFS_SYNC_AUTH_HEADER_VALUE`; per endpoint, `IPFS_SYNC_RPC_AUTH_*` or
`IPFS_SYNC_GATEWAY_AUTH_*`) and never echoes the value. The same rule covers
the vault passphrase: no `--passphrase` flag exists.

Two related rules: a `./ipfs-sync.config.json` found in the working directory
is refused (exit 2) when it sets a node address while a credential is
configured by environment or flags — pass `--config <path>` to use a file on
purpose; and a plain `http:` endpoint with a credential on a non-loopback host
gets a warning (anyone on the network path can read the credential).

The global auth is the RPC credential. The gateway inherits it only when both
endpoints share an origin (scheme, host, port); on any other origin the gateway
gets no credential unless you set `IPFS_SYNC_GATEWAY_AUTH_*` explicitly.

## The pull confirmation ceiling, and what the CLI does not have

<!-- source: README.md L471-484 -->

`pull` asks before fetching more than 512 MiB of file content
(`--max-bytes <n>` changes the ceiling; `--accept-large` is the non-interactive
yes). In the v0.4.0 demo the first pull of a ~954.9 MiB vault stopped at this
ceiling with exit 1 and fetched nothing until re-run with `--accept-large` —
see [Evidence](evidence.md).

**The CLI has no read cap and no exclusion option.** Both exist only in the
plugin (the per-file read cap setting and the user exclusion list). A CLI
publish reads a file of any size and applies only the built-in exclusion list.
This is documented as-is; it is not fixed here. In the demo, the vault's
195.4 MiB file published uncapped.

## Exit codes

<!-- source: cli/help-text.ts L244-258; README.md L477-480 -->

- **0** — ok (for `pull`, 0 also covers paths skipped as expected, such as
  `.obsidian/` or excluded paths from an older manifest; for `history`, 0 also
  means no operations recorded).
- **1** — a check, publish or pull failed: a file failed verification or was
  not fetched, a path was skipped as unsafe, or the run stopped at a check
  (wrong passphrase, rollback, fork, a held lock, an unconfirmed question). A
  confirmation that was asked and declined also exits 1.
- **2** — usage, unsafe configuration or a refused destination. Whether any
  request was sent depends on the refusal class:
  - **Preflight refusals send no request.** Unknown flags, invalid flag
    combinations, a missing RPC or gateway URL (`no-rpc-url` /
    `no-gateway-url`), credential flags given on the command line, a
    working-directory config file steering a credential, and a passphrase
    file inside the vault are all refused before the node is contacted. A
    command that needs a confirmation and has neither a terminal nor its
    confirming flag (`--accept-no-revocation`, `--yes-prune`/`--dry-run`,
    `--yes-discard`, `--yes-abandon`) also exits 2 before any request;
    `pull --resolve-fork` has no confirming flag, so without a terminal it
    always exits 2.
  - **Remote-format refusals happen after read-only requests.** Detecting a
    plaintext (release 0.2.0) root requires the pull to resolve the IPNS name
    and list the remote root first, and a missing `manifest.enc` is found the
    same way. The refusal is exit 2 with **nothing written** — no file on
    your disk changes and nothing mutating is sent — but those reads
    occurred.

A question is asked only when standard input, standard output and standard
error are all terminals; with any of the three redirected, the run cannot ask.

## Interrupted operations

<!-- source: README.md L781-854; cli/help-text.ts L86-89, L136-137 -->

A pending rewrap or prune is finished by running the same command again — the
rerun needs none of the confirming flags and takes what to finish from the
journal; the rest of that command line is ignored. `keys discard` drops the
operation when a rerun cannot finish it. After a killed publish, the next
`publish` resumes, adopts or discards the journal based on the node's
authenticated manifest; `--repair`, `--recover-slots` and `--break-lock` exist
for the refusal cases and are described in `--help` and in the operator runbook
(`docs/operator/encrypted-vault.md` in the repository).
