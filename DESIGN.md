# IPFS Sync — Design Document

Status: **draft — pre-implementation spec. Do not build from this without sign-off.**
Companion to the README (operations) — this file is the architecture spec.

## 1. Goals

- Sync an Obsidian vault over IPFS through our own kubo node
  (`https://ipfs.prometheusags.ai`) — no Obsidian Sync subscription, no third-party cloud.
- Work on **desktop (macOS first), iOS, and Android** from the same plugin codebase.
- Provide the substrate for a later AI layer: embeddings and indexes stored as
  content-addressed data pinned to the vault snapshot, so any device gets the
  index that matches its snapshot for free.
- The user writes and owns the plugin. This repo is that plugin.

## 2. Hard constraints (mobile-first rules)

Derived from Obsidian mobile = Capacitor WebView (WKWebView / Android WebView):

| Constraint | Consequence |
|---|---|
| iOS suspends the app off-screen | Sync model = "fast catch-up on app open", never background |
| Memory capped, jetsam kills | No monolithic FormData / no whole-vault ArrayBuffers; everything streams and is incremental |
| Intermittent, metered networks | Delta-only transfers in both directions |
| WebView has only HTTP(S)/WSS | Phones never speak libp2p/DHT directly; they reach an always-on daemon over WSS |

## 3. Architecture overview

```
┌────────────┐   HTTPS RPC    ┌──────────────────────────┐
│  Desktop   │◄──────────────►│  ipfs.prometheusags.ai   │
│  (plugin)  │                │  kubo: storage + pins    │
└────────────┘                │  + IPNS pointer          │
                              └──────▲───────────────────┘
┌────────────┐   HTTPS RPC         │ WSS (Phase 2)
│  iOS app   │◄────────────────────┘
│  (plugin)  │                ┌──────────────────────────┐
└────────────┘                │  VPS sync daemon         │
┌────────────┐   HTTPS RPC   │  (Phase 2: Helia+OrbitDB │
│ Android app│◄─────────────►│  "Voyager" persistent    │
│  (plugin)  │                │  peer, always online)    │
└────────────┘                └──────────────────────────┘
```

- **Phase 1.1 (this spec's implementation target):** snapshot pointer (IPNS) +
  delta transfers, all via kubo HTTP RPC. Mobile-compatible.
- **Phase 2:** op-log CRDT (OrbitDB) replicating through the VPS daemon; kubo
  remains the block store. Snapshot layer degrades to bootstrap/restore.
- **Phase 3:** AI layer — embeddings index as content-addressed data pinned to
  the vault root; semantic search, RAG chat, auto-backlinks.
- **Phase 4:** availability/polish — pinning strategy, selective sync, conflict center.

## 4. Phase 1.1 spec — delta sync over the RPC

### 4.1 Node-side layout (MFS)

Fixed persistent staging tree (replaces the per-run timestamped dirs of Phase 1):

```
/obsidian-vault-sync/
  current/                  ← the vault tree; publish mutates in place
    <vault-relative files>
  manifests/
    <rootCID>.json          ← one manifest per published root (immutable, small)
```

- Publishing changed files writes only those paths into `current/`, removes
  deleted ones (`files/rm`), then `files/stat /obsidian-vault-sync/current`
  yields the new root CID. Cost: O(changes), not O(vault).
- Manifests are content-addressed by the root they describe; old roots stay
  resolvable (free history: pulling an old manifest = point-in-time restore).

### 4.2 Manifest schema

`.ipfs-sync.manifest.json`, stored at the snapshot root (and mirrored to MFS
under `manifests/`):

```json
{
  "version": 1,
  "rootCID": "bafy…",
  "publishedAt": "2026-09-29T17:00:00Z",
  "device": "macbook",              
  "files": {
    "notes/hello.md": { "sha256": "…", "size": 1234, "cid": "bafk…" },
    "attachment.pdf": { "sha256": "…", "size": 45678, "cid": "bafy…" }
  },
  "excludesHash": "sha256 of the effective exclusion list"
}
```

- `sha256` (WebCrypto, cheap on mobile) is the change-detection key; `cid` is
  the fetch key. Local files are hashed and compared — only misses/mismatches transfer.
- `version` gates schema evolution.
- Files under exclusion paths are absent from `files` — exclusion list lives in
  the plugin settings, shared with the CLI via `scripts/excludes.txt`.

### 4.3 Plugin behavior

**Publish (per-file pool, 4–6 concurrent):**
1. Enumerate vault files (exclusions applied). Compute sha256 for files not in
   the last local manifest, or whose size/mtime changed (fast pre-filter).
2. `files/write` each changed file to `/obsidian-vault-sync/current/<path>`
   (multipart `data` field; args in query string — proxy quirks, see README §node-quirks).
3. `files/rm` paths present remotely (last manifest) but absent locally.
4. `files/stat` → new root CID → `pin/add`.
5. Write manifest JSON → add it (pinned) → mirror into `manifests/`.
6. `name/publish` root CID to the `obsidian-vault` IPNS key (`ttl=5m`).

**Pull (delta, streamed):**
1. `name/resolve` → root CID → `cat <root>/.ipfs-sync.manifest.json`.
2. Compare manifest against local files (sha256 pool).
3. Fetch only missing/changed files via `cat` (pool), write via `vault.create` / `vault.modify`.
4. Conflict policy (unchanged from Phase 1): **remote wins, local content preserved**
   as `name (ipfs conflict YYYY-MM-DD)`. Never delete local files in 1.1.

**Triggers:** command palette (publish/pull/status), ribbon, on-load catch-up
(enabled per device), debounced after-save publish (opt-in). All foreground.

**Config sync:** `.obsidian/` stays excluded on mobile; desktop may optionally
include a whitelist of config files (plugin settings for this plugin).

### 4.4 CLI scripts

`publish.sh` / `pull.sh` gain the same delta logic (fixed `current/` tree,
manifest-driven). Scripts remain desktop tools; mobile uses the plugin only.

## 5. Server-side prerequisites (not plugin code)

1. **Gate `/api/v0` with bearer auth at the proxy.** The endpoint is currently
   open to the internet for writes (verified during bring-up). Plugin + scripts
   already send `Authorization: Bearer $IPFS_RPC_TOKEN` when set.
2. Optional: read-only gateway subdomain for content retrieval (`cat`/`get`
   without write scopes), if we want defense-in-depth.

## 6. Phase 2 spec sketch — op-log via sync daemon (not yet final)

- **Log model:** one OrbitDB `documents` record per vault file:
  `{ path, contentCID, sha256, size, mtime, deleted: bool, lamport }`.
  Attachments referenced by CID (dedup across devices for free).
- **VPS daemon:** Node process next to kubo; Helia + OrbitDB hosting the log
  ("Voyager"-style persistent peer). kubo continues to store/pin blocks.
- **Clients (desktop + mobile plugins):** replicate over **WSS to the daemon
  only** — no DHT, no raw sockets from WebViews. Delta sync on both ends.
- **Merging:** Merkle-CRDT; concurrent edits converge; per-file conflicts
  resolved by policy (default: higher lamport wins, loser preserved as conflict copy).
- **Encryption (decision pending):** per-file AES-GCM with a vault key vs.
  private libp2p network. Leaning per-file: works over the daemon without
  transport assumptions, and survives gateway exposure.
- **IPNS pointer** remains as bootstrap: new device resolves IPNS → gets latest
  root + log head → joins replication.

## 7. Phase 3 sketch — AI layer (decision pending, specs TBD)

- Embeddings computed on a capable device, stored as content-addressed index
  pinned under the vault root (`/.ipfs-sync/ai/`):
  ```
  .ipfs-sync/ai/
    index-<snapshotCID>.jsonl.zst   ← chunk embeddings, keyed by file sha256
    meta.json                        ← model id, dim, version
  ```
- Index keyed by content hash → automatically correct for any device that has
  those files; mismatched files just miss.
- Features: semantic search, RAG chat (replaces vault-chat + its plaintext API key),
  embedding-similarity backlink suggestions, clustering.
- Open questions: local embeddings (transformers.js in WebView = heavy) vs.
  API embeddings (cost, privacy); index size at 10k notes; update cadence.

## 8. Security & privacy posture

- Until RPC auth lands, **treat everything published as world-readable**.
- No secrets in the vault (rotate the OpenAI key found in vault-chat config and
  "Keys and Stuff.md" — independent of this project, blocking cloud exposure).
- Optional at-rest encryption decision deferred to Phase 2 (§6).

## 9. Explicit non-goals

- Real-time collaborative editing (single-writer-per-file is fine).
- Syncing `.trash`, `.obsidian` workspace state, or OS metadata.
- Background sync on iOS (impossible; not attempted).
- Windows/Linux desktop parity in 1.1 (plugin is platform-neutral; only macOS
  is tested).

## 10. Open questions (need user specs)

1. RPC auth mechanism (bearer via proxy? client certs? IP allowlist + Tailscale?)
2. Phase 2 encryption choice (per-file AES-GCM vs private network).
3. Embedding provider for Phase 3 (local vs API; which model).
4. Multiple vaults on one node? (MFS layout is currently single-vault.)
5. Retention: how many old manifests/roots to pin before GC?
6. Conflict policy preference: remote-wins vs duplicate-file (obsidian-decentralized's default).
