# IPFS Sync for Obsidian

Sync your vault over IPFS through your own kubo node (`https://ipfs.prometheusags.ai`).
No Obsidian Sync subscription. No third-party cloud. Content-addressed snapshots now,
CRDT multi-writer sync and an AI layer later.

## What's here (Phase 1)

| Piece | Where | What it does |
|---|---|---|
| Obsidian plugin | `src/main.ts` → `.obsidian/plugins/ipfs-sync/` | Publish / Pull / Status commands, settings tab, optional auto-publish |
| CLI publish | `scripts/publish.sh` | Stage vault → MFS → pin → publish IPNS pointer |
| CLI pull | `scripts/pull.sh` | Resolve IPNS → download snapshot tar → conflict-safe merge |
| Exclusions | `scripts/excludes.txt` | Shared by both paths (trash, workspace churn, this dev folder) |

**Mutable pointer:** IPNS key `obsidian-vault` on your node
(`k51qzi5uqu5dhma4iyf9sx5q5t227y56ubswmdws0ytq67rsxzi74t0vzj3ina`).
The vault root CID is republished to this key on every publish; pulls resolve it.
Swap for DNSLink (`_dnslink.ipfs.prometheusags.ai` → `/ipfs/<cid>`) whenever you
want a human-readable name — same content, one DNS record.

**Conflict policy (both plugin and CLI):** pull never deletes and never loses
data. If a local file differs from the remote version, the remote becomes
canonical and the local content is preserved as `name.ext (ipfs conflict YYYY-MM-DD)`.
True merging arrives with the Phase 2 op-log.

## Enable the plugin

Already built and installed. In Obsidian:
`Settings → Community Plugins` → turn off Restricted mode if on → enable **IPFS Sync**.
Then `Ctrl/Cmd+P` → "IPFS Sync: Publish vault to IPFS".

Dev loop: `npm install && npm run dev` (watches and rebuilds into
`.obsidian/plugins/ipfs-sync/`). Production build: `npm run build`.

## CLI usage

```bash
# publish this machine's vault (defaults: node, key, ~/obsidian)
.ipfs-sync/scripts/publish.sh

# pull on another machine
IPFS_RPC_URL=https://ipfs.prometheusags.ai \
  .ipfs-sync/scripts/pull.sh

# env vars: IPFS_RPC_URL, IPFS_KEY, VAULT_DIR, IPFS_RPC_TOKEN
```

Both scripts are pure `curl` against the kubo HTTP RPC — no local IPFS daemon needed
(your local `ipfs` CLI is older than its repo and can't run; irrelevant here).

## Your node's quirks (discovered during bring-up, encoded in the code)

1. **Form-encoded RPC args are dropped by the reverse proxy.** Every kubo argument
   must travel in the **query string**. The plugin's `ipfsRequest()` already does
   this; the scripts use `curl -G`.
2. **`files/write` requires a multipart body with field name `data`** (not a raw
   body). This is non-standard for kubo — likely the proxy's own requirement.
3. **macOS ships openrsync** (not GNU rsync). Its `--update` semantics can't be
   trusted, which is why pull uses explicit backup-and-replace.

## ⚠ Security: your RPC endpoint is wide open

`https://ipfs.prometheusags.ai/api/v0/` currently accepts **unauthenticated
writes from the entire internet**: anyone can `add`/`pin` garbage, create IPNS
keys, or republish *your vault pointer* if they learn its key name. Your node also
hosts other projects' keys (`consult-capture`, `gomark-relay-lab`, `prince-live`).
Before this becomes your real sync backbone:

- Put auth in front of the RPC (nginx/basic-auth or a bearer token at the proxy),
  and set the same token in the plugin's settings + `IPFS_RPC_TOKEN`.
- Or restrict `/api/v0` to your IPs/VPN.
- Long-term: keep the RPC private; expose only a read-only gateway for content.

Until then, treat every file you publish as public.

## Roadmap

- **Phase 2 — real sync:** embed [Helia](https://github.com/ipfs/helia) + [OrbitDB](https://orbitdb.org)
  in the plugin. One op-log record per file (path, content CID, mtime, tombstones);
  Merkle-CRDT merging makes concurrent edits on two devices conflict-free; the
  snapshot layer in this repo becomes the bootstrap/restore path. The RPC seam is
  `ipfsRequest()` — that's the only thing Phase 2 replaces.
- **Phase 3 — the AI layer:** embeddings computed on your Mac, stored as
  content-addressed data pinned to the vault root — every device gets the index
  that matches its snapshot for free. Semantic search, RAG chat, auto-backlinks.
  (This replaces the vault-chat plugin and its plaintext API key.)
- **Phase 4 — mobile + always-on pinning** (`ipfs-cluster` or a second node).

## Loose end on your node

`/obsidian-vault-staging` in MFS contains older content (FLINT specs, meeting
recordings) from a previous sync attempt. This tooling deliberately uses
`/obsidian-vault-sync/publish-<timestamp>` per run and never touches it. Delete it
from MFS yourself when you've confirmed you don't need it.
