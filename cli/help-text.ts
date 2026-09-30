export const HELP_TEXT = `ipfs-sync - vault sync over your own kubo node

Usage:
  ipfs-sync status [options]
  ipfs-sync publish <vault> [options]
  ipfs-sync pull <vault> [options]

Commands:
  status                  Show node identity, MFS listing, gateway fetch, write probe and key state.
  publish <vault>         Send only the changed files of <vault> to the node, then publish the snapshot to
                          the IPNS key. Only synthetic fixture vaults (marker file .ipfs-sync-fixture) are
                          accepted until encryption exists. Creates the key when it does not exist yet and
                          records its ID in the config file (ownedKeys).
  pull <vault>            Bring <vault> to the published state by fetching only missing or changed files.
                          Every file is hashed against the manifest before it appears; local edits are kept
                          as "<name> (ipfs conflict YYYY-MM-DD).<ext>" and never deleted; remote deletions
                          are only reported. Reads only (name resolve, gateway); writes nothing to the node.
                          The destination must be absent, empty or hold the .ipfs-sync-fixture marker until
                          encryption exists (a pulled fresh directory gets the marker).

Options:
  --config <path>         Config file (default ./ipfs-sync.config.json if present). Endpoints and
                          non-secret fields only; secrets are rejected.
  --rpc-url <url>         RPC (write) endpoint.
  --rpc-port <port>       RPC port, applied to --rpc-url.
  --gateway-url <url>     Gateway (read) endpoint.
  --gateway-port <port>   Gateway port, applied to --gateway-url.
  --mfs-root <path>       MFS root; must be /obsidian-vault-sync or below it (default /obsidian-vault-sync/default).
                          publish needs a root strictly below /obsidian-vault-sync.
  --key <name>            IPNS publication key name; must match ^obsidian-vault(-[a-z0-9-]+)?$
                          (default obsidian-vault-sync).
  --owned-key <id>        IPNS key ID this installation owns (repeatable). For this run only; never written
                          to the config file.
  --auth <scheme>         none | basic | bearer | header.
  --auth-user <user>      basic: user.
  --auth-password <pw>    basic: password.
  --auth-token <token>    bearer: static token or JWT.
  --auth-header-name <n>  header: header name.
  --auth-header-value <v> header: header value.
  --name <id>             pull: IPNS key ID to pull from (default: the ID of the owned key given by --key).
  --manifest <cid>        pull: restore the snapshot published when current/ had this CID (manifests/<cid>.json).
  --manifest-file <path>  pull: read the manifest from a local file. --manifest and --manifest-file exclude each other.
  --show-request          Print each request (method, URL, headers) with credentials redacted.
  -h, --help              Show this help.

Environment (secrets belong here, not on the command line):
  IPFS_SYNC_RPC_URL, IPFS_SYNC_RPC_PORT, IPFS_SYNC_GATEWAY_URL, IPFS_SYNC_GATEWAY_PORT,
  IPFS_SYNC_MFS_ROOT, IPFS_SYNC_KEY
  IPFS_SYNC_AUTH_SCHEME, IPFS_SYNC_AUTH_USER, IPFS_SYNC_AUTH_PASSWORD, IPFS_SYNC_AUTH_TOKEN,
  IPFS_SYNC_AUTH_HEADER_NAME, IPFS_SYNC_AUTH_HEADER_VALUE
  IPFS_SYNC_DEVICE (publish: device name recorded in the manifest, default "cli")
  Per-endpoint auth override: IPFS_SYNC_RPC_AUTH_* or IPFS_SYNC_GATEWAY_AUTH_* (same suffixes).

Precedence: flags > environment > config file > defaults.

Exit codes: 0 ok, 1 a check, publish or pull failed (pull: a file failed verification), 2 usage, unsafe
configuration or a refused pull destination (no request is sent).
`;
