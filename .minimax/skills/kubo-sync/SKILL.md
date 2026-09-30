---
name: kubo-sync
description: >
  Sync an Obsidian vault to a self-hosted kubo (IPFS) node over the RPC API:
  MFS staging and persistent trees, IPNS naming, delta sync via manifest,
  per-file uploads, CAR export for large vaults. Encodes the hard-won proxy
  quirks of the ipfs.prometheusags.ai deployment (args must be query-string,
  files/write multipart field is `data`). Use when implementing or debugging
  vault publish/pull, MFS layout, IPNS resolution, or the shared kubo RPC client.
license: MIT
metadata:
  author: prometheus-ags
  version: '1.0.0'
  category: development
  tags: [ipfs, kubo, mfs, ipns, delta-sync, obsidian]
user-invocable: true
---

# kubo-sync

Operational knowledge for syncing an Obsidian vault to your own kubo node.
Everything here was learned by running the stack, not from documentation alone.
Contradictions with upstream kubo docs are noted where the deployment diverges.

## The deployment

- Node: `https://ipfs.prometheusags.ai` (kubo RPC, observed v0.42.0).
- **The RPC is open-write with no authentication.** Anyone can mutate MFS and
  publish IPNS under your key names until token gating lands (see
  `identity-security` skill and DESIGN §5). Treat every operation as
  reversible-by-attacker and keep the local vault as the source of truth.
- Default IPNS key: `obsidian-vault` →
  `k51qzi5uqu5dhma4iyf9sx5q5t227y56ubswmdws0ytq67rsxzi74t0vzj3ina`.

## Proxy quirks (breaking — read before writing any client code)

1. **All API args go in the query string.** Form-encoded POST bodies are
   silently dropped by the reverse proxy. `POST /api/v0/files/write?arg=/path&create=true&parents=true`
   with a multipart body **only** for file bytes.
2. **`files/write` expects the file bytes in a multipart field named `data`.**
   Other field names are ignored; the call succeeds with an empty write.
3. URL-encode args: MFS paths contain slashes — encode the *value*, not the
   whole URL. `encodeURIComponent(arg)`.
4. Always assert the response: a 200 with a JSON error body, or a "success"
   that wrote zero bytes (quirk 2), looks identical to a real success until
   you `files/stat` the path.
5. There is one shared RPC client in the repo (`src/kubo/`). These quirks may
   live **only** there. Any second implementation reintroduces the bugs.

## MFS layout (canonical)

```
/obsidian-vault-sync/
  staging-<ISO-timestamp>/   # per-publish staging tree (docs/001 pool style)
  current/                   # persistent pointer tree — what pull resolves
  publish-real-20260929/     # leftover partial staging from bring-up; inspect
                             # then delete or resume — verify with files/ls first
```

Publish = write changed files into a new staging tree, then atomically point
`current/` at it (write the new root CID into a small `root` file in
`/obsidian-vault-sync/` rather than `files/cp -r`, which is not atomic and
races concurrent publishers). Pull = resolve IPNS → read `root` → walk the
manifest → fetch only missing/changed files.

## Delta sync contract

- Manifest lives in the vault root as `.ipfs-sync.manifest.json` and is itself
  synced. Entry: `{ path, size, mtimeMs, cid, sha256 }` per file.
- Exclusion list is device-local config (`.obsidian/workspace*`, `.trash/`,
  `node_modules/`, OS droppings). `excludesHash` — a hash of the sorted
  exclusion list — is recorded in the manifest so a device with a different
  exclusion set detects itself as divergent and publishes a full manifest
  rather than corrupting peers' state (DESIGN §4.2; operator decision: keep
  `excludesHash`, spec 011).
- Publish flow: diff vault walk vs manifest → per-file `files/write` for
  changed paths → new manifest CID → update `root`.
- Conflict policy (same as the old shell scripts): **remote wins**; the local
  file is preserved as `<name> (ipfs conflict YYYY-MM-DD)` before overwrite.
  Phase 2 replaces this with the CRDT op-log — do not invest in smarter merging.

## Per-file vs monolithic upload (decided: per-file)

Multipart `add` of a whole tar is monolithic: no resume, no partial progress,
and a mobile-memory hazard (assessment Goal 1). Per-file `files/write` gives
resumability per file, real progress events, and delta granularity. Chunking
recommendation: files over ~32 MB stream in 8 MB `files/write` chunks with
explicit `offset` (no `truncate` until the final chunk).

## WebView / mobile constraints

- The Obsidian mobile WebView has **no Node APIs**: no `fs`, no `child_process`,
  no native modules. The shared client must run on `fetch` + `FormData` +
  `URL` only. The Node 24 CLI reuses the same client — this is the point of
  the seam.
- Cap in-flight ArrayBuffers: process files sequentially on mobile; hold at
  most one file body plus the manifest in memory.
- Mobile is **client-only**. It never serves; desktop/daemon does (spec 008).

## API surface used

| RPC | Purpose | Notes |
|---|---|---|
| `files/write` | upload file bytes | multipart field `data`, args in query |
| `files/ls`, `files/stat` | verify writes | always stat after write (quirk 2) |
| `files/rm -r` | drop old staging trees | only after `current` is repointed |
| `add` | pin loose blocks if needed | prefer MFS; `add` returns CID not path |
| `cat` | fetch file bytes | use `/api/v0/cat?arg=<cid>` |
| `dag/export` | CAR snapshot of the vault | for 1 GB+ E2E and disaster recovery |
| `name/publish`, `name/resolve` | IPNS pointer | resolve with `nocache=true` when testing |

## Large-vault E2E evidence

The 1 GB real-vault publish is the MVP completion gate. Expected path:
per-file writes (~seconds each), manifest write, root update, IPNS publish,
then a fresh `name/resolve` from a cold cache. Record timing and any retry
counts in `.prometheus/session-log.md`.

## Hard rules

- Node 24 + TypeScript 7 only. No shell scripts, no Python, no curl in product
  code (`versions.toml` decisions, spec 004).
- Never create a second HTTP path to kubo outside `src/kubo/`.
- Verify with `files/stat` after every write; trust no 200.
- Encrypt before `add`/MFS write when client-side encryption ships
  (spec 005 Q2, `ucan-identity` skill) — IPFS is transport-encrypted only.
