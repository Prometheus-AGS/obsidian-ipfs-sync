# IPFS Sync for Obsidian

Sync your vault over IPFS through your own kubo node (`https://ipfs.prometheusags.ai`).
No Obsidian Sync subscription. No third-party cloud. Content-addressed snapshots now,
CRDT multi-writer sync and an AI layer later.

> **Fixture-only pre-release. Do not use it on real notes.** This build has no
> encryption. It publishes plaintext, so everything it sends to your kubo node is
> readable by anyone who obtains the CID. To keep that from happening by accident, the
> CLI and the plugin accept only synthetic fixture vaults (marked by a
> `.ipfs-sync-fixture` file in the vault root) and refuse any other vault. Encryption is
> planned for a later release (change `mvp-06`); only after it ships is it meant for real notes.
> Version 0.2.0 is not released yet: `manifest.json` still reads 0.1.0.
> It is a pre-release by design: what counts as a release is the demonstrated behaviour
> inside Obsidian desktop, and that demonstration has not been recorded yet.
> The release demonstration targets Obsidian desktop on macOS and has not been recorded yet, so nothing is verified
> on any platform yet. Mobile, Windows and Linux are not verified either.

## What's here (Phase 1)

| Piece | Where | What it does |
|---|---|---|
| Obsidian plugin | `src/main.ts` → `dist/plugin/` (`main.js`, `manifest.json`) | Publish, Pull and Status commands, settings tab, optional auto-publish, optional pull on load. Fixture vaults only |
| CLI publish | `ipfs-sync publish` | Send only changed files to the node's MFS, then publish the snapshot to the IPNS key |
| CLI pull | `ipfs-sync pull` | Resolve the IPNS name → read the manifest → fetch only differing files → conflict-safe merge |
| Exclusions | `src/sync/exclusions.ts` | Shared exclusion list: trash, workspace churn, this dev folder and the fixture marker file. The whole `.obsidian/plugins/` folder is never published or pulled: plugin code and plugin data are device-local |

**Mutable pointer:** the project IPNS key `obsidian-vault-sync` on your node. `publish`
creates it if absent and records its ID in the config file (`ownedKeys`). Each publish
points the key at the CID of the MFS root (`current/`, `manifest.json`, `manifests/`);
pulls resolve it.
Swap for DNSLink (`_dnslink.ipfs.prometheusags.ai` → `/ipfs/<cid>`) whenever you
want a human-readable name — same content, one DNS record.

**Conflict policy (CLI and plugin pull; both run the same engine):** pull never deletes and never loses
data. If a local file differs from the remote version, the remote becomes
canonical and the local content is preserved as `name (ipfs conflict YYYY-MM-DD).ext`
(the extension is kept so the copy opens in the same app). Pull leaves files that are
remotely deleted in place and reports them; remote deletions are not applied.
Pull also refuses manifest paths it must not write: absolute paths, `..` segments,
backslashes, anything inside `.ipfs-sync/`, anything under `.obsidian/plugins/`, and
anything on the exclusion list. A refused path is counted as failed; the rest of the pull continues.
True merging arrives with the Phase 2 op-log.

## Obsidian plugin

**Fixture-only.** The plugin publishes plaintext and has no encryption. Publish works only in a
vault that contains the `.ipfs-sync-fixture` marker. Pull works in a vault that contains the marker, or that has
no files outside `.obsidian/` and `.ipfs-sync/` (Pull then creates the marker). Any other vault is refused before
a single request is sent, with a notice. Do not install this on a vault that holds real notes.

`pnpm build` writes the plugin to `dist/plugin/` (`main.js` and `manifest.json`) and the CLI
to `dist/cli/ipfs-sync.mjs`. A build never writes into a vault by default. To load the plugin
in Obsidian, copy the two files from `dist/plugin/` into `<vault>/.obsidian/plugins/ipfs-sync/`,
then enable **IPFS Sync** under `Settings → Community Plugins`.

Dev loop: `pnpm install && pnpm dev` watches and rebuilds. `pnpm dev` writes the plugin to
`dist/plugin/` unless the `OBSIDIAN_PLUGIN_DIR` environment variable is set; then it writes
`main.js` and `manifest.json` into that directory, for example
`OBSIDIAN_PLUGIN_DIR=<vault>/.obsidian/plugins/ipfs-sync pnpm dev`. `pnpm build` ignores
the variable. Warning: `OBSIDIAN_PLUGIN_DIR` overwrites the plugin files in that directory on
every rebuild. Do not point it at a vault you do not want to overwrite.

Requires Obsidian 1.12.3 or later (`minAppVersion`). The release demonstration targets Obsidian desktop on macOS; it has not been recorded yet.
`isDesktopOnly` is false in the manifest, but mobile has not been run.

What the plugin does today:

- Commands (`Ctrl/Cmd+P`): **IPFS Sync: Publish vault**, **IPFS Sync: Pull vault** and
  **IPFS Sync: Show status**. Two ribbon icons run Publish and Pull. An optional auto-publish
  interval (minutes, 0 = off) is set in the settings tab.
- Pull reads only: name resolve, key list and gateway reads. It changes nothing on the node. It saves
  every open editor first, so an edit that exists only in an editor counts as a local edit. Progress
  and the result show as a notice and in the status bar. The result names the fetched,
  unchanged, conflict, failed and remote-deletion counts and up to three conflict copies. It says
  "incomplete" when any file failed.
- Pull target: the **pull name** setting (an IPNS key ID; a `/ipns/` prefix is accepted). When it is empty the
  plugin uses the ID of the publication key, but only if that key exists on the node and is recorded as owned.
  Otherwise Pull stops before fetching and tells you to set a pull name.
- Publish and Pull do not run at the same time in one vault; the second request is ignored with a notice.
- **Catch-up on load** (setting, off by default, per device): one pull after the workspace layout is ready.
  It obeys the same guards as a manual pull, does not delay startup, and shows a notice only when it
  changed files, made a conflict copy, or failed.
- **Read cap** (setting): the largest single file the plugin will read into memory, default 64 MB,
  whole numbers from 8 to 1024. Obsidian's file adapter has no partial read, so a file is loaded whole. A file
  above the cap is counted as failed, named in the result, and the other files continue.
- Settings tab: RPC and gateway endpoints (URL plus optional port each), publication key name,
  MFS root, authentication scheme (none, basic, bearer, custom header), the exclusion list, the
  owned IPNS keys, and the pull name, catch-up and read cap settings above, plus the last pull and last publish summaries
  (counts, CIDs and timestamps only, no file names or secrets).
- Node requests go through Obsidian's `requestUrl`, not `fetch`, because the node's CORS
  rules block the WebView (quirk 4 below).
- `.obsidian/plugins/` is never published and never pulled: plugin code and plugin data, including this
  plugin's own `data.json` with your credentials, stay on the device.

### Try it: the pull demo (two fixture vaults)

This is the path the release demonstration uses. It needs a kubo node you control and the endpoints
set as in "CLI usage". Nothing here touches a real vault.

1. Build: `pnpm install && pnpm build`.
2. Make a fixture vault to publish from: `pnpm fixture:generate <dir-A>`.
3. Publish it: `node dist/cli/ipfs-sync.mjs publish <dir-A> --mfs-root /obsidian-vault-sync/<demo-name>`.
   The first publish creates the IPNS key and records its ID under `ownedKeys` in the CLI config file.
   Note that ID.
4. Make the receiving vault: create a new, empty vault in Obsidian (or an empty folder opened as a vault).
   Copy `dist/plugin/main.js` and `dist/plugin/manifest.json` into
   `<vault-B>/.obsidian/plugins/ipfs-sync/` and enable **IPFS Sync**.
5. In the plugin settings, enter the RPC and gateway endpoints and auth as you did for the CLI, and set the
   **pull name** to the ID from step 3. (The plugin's owned-key list is empty in a new vault, so the empty-name default finds nothing.)
6. Run **IPFS Sync: Pull vault**. Vault B receives the files and the `.ipfs-sync-fixture` marker.
7. To see a conflict: edit a file in vault B, change the same file in vault A, run `publish` again,
   then Pull in vault B. The published version replaces the file and your edit is kept as
   `name (ipfs conflict YYYY-MM-DD).md` next to it.

What this shows and what it does not: it shows the delta pull and the conflict copy inside Obsidian desktop.
It does not show mobile, an authenticated endpoint, Windows or Linux, or any use on real notes.

### Plugin limitations

- No encryption; fixture vaults only (above).
- The plugin cannot detect symbolic links, because Obsidian's file adapter has no `lstat`. The CLI refuses to
  write through a symlink; the plugin cannot make that check. Do not place symlinks in a vault you sync.
- Writes go through a temporary file in `.ipfs-sync/tmp/` and then a rename. Where the destination already exists,
  the plugin removes it first and then renames, so a crash in between can leave the file missing until the next pull.
  This window has not been tested.
- Remote deletions are reported, not applied. A file deleted on the publishing side stays on the receiving side.
- Per-file read cap (above). Large files cost whole-file memory.
- Mobile, Windows and Linux are not verified.

## CLI usage

Requires Node >= 24.15 and pnpm. Build once, then run the CLI (or the `ipfs-sync` bin):

```bash
pnpm install && pnpm build

node dist/cli/ipfs-sync.mjs status
node dist/cli/ipfs-sync.mjs publish <vault>
node dist/cli/ipfs-sync.mjs pull <vault> [--name <ipns-id>] [--manifest <currentCID> | --manifest-file <path>]
```

- `status` shows node identity, MFS listing, gateway fetch, write probe and key state.
- `publish` sends only changed files. `pull` fetches only files whose sha256 differs.
  `pull` without `--name` uses the ID of the owned `obsidian-vault-sync` key;
  `--manifest` restores an earlier snapshot; `--manifest-file` reads a local manifest.
- Endpoints and auth: `--rpc-url`, `--gateway-url`, `--mfs-root`, `--key`, `--config`,
  `--auth`, or the `IPFS_SYNC_*` environment variables (`IPFS_SYNC_RPC_URL`,
  `IPFS_SYNC_GATEWAY_URL`, `IPFS_SYNC_MFS_ROOT`, `IPFS_SYNC_KEY`, `IPFS_SYNC_AUTH_*`).
  Flags override environment, which overrides the config file. Run
  `node dist/cli/ipfs-sync.mjs --help` for the full list.

**Current limits of this build:** it publishes plaintext. Client-side encryption is not
implemented yet (planned for a later increment), so `publish` accepts only synthetic
fixture vaults, marked by a `.ipfs-sync-fixture` file in the vault root. It refuses a real
vault. Do not point it at your notes.

The CLI is a plain Node HTTP client against the kubo RPC and gateway — no local IPFS
daemon needed.

## Your node's quirks (discovered during bring-up, encoded in the code)

1. **Form-encoded RPC args are dropped by the reverse proxy.** Every kubo argument
   must travel in the **query string**. The shared kubo client (`src/kubo`, used by the
   plugin and the CLI) sends arguments that way.
2. **`files/write` requires a multipart body with field name `data`** (not a raw
   body). This is non-standard for kubo — likely the proxy's own requirement.
3. **`name/resolve` needs `nocache=true`.** Kubo caches IPNS lookups for the record TTL,
   so without it a pull right after a publish can resolve the previous snapshot. The CLI
   always sends it.
4. **CORS blocks the Obsidian WebView.** The node answers requests with the origin
   `app://obsidian.md` with 403 and sends no CORS headers, so the WebView's `fetch` cannot
   reach it. The plugin sends every node request through Obsidian's `requestUrl`, which is
   not subject to CORS. The CLI uses plain `fetch` and is unaffected.

## ⚠ Security: your RPC endpoint is wide open

`https://ipfs.prometheusags.ai/api/v0/` currently accepts **unauthenticated
writes from the entire internet**: anyone can `add`/`pin` garbage, create IPNS
keys, or republish *your vault pointer* if they learn its key name. Your node also
hosts other projects' keys (`consult-capture`, `gomark-relay-lab`, `prince-live`).
Before this becomes your real sync backbone:

- Put auth in front of the RPC (nginx/basic-auth or a bearer token at the proxy),
  and set the same token in the plugin's settings and pass it to the CLI with
  `--auth bearer` and `IPFS_SYNC_AUTH_TOKEN`.
- Or restrict `/api/v0` to your IPs/VPN.
- Long-term: keep the RPC private; expose only a read-only gateway for content.

Until then, treat every file you publish as public.

## Roadmap

- **Phase 2 — real sync:** embed [Helia](https://github.com/ipfs/helia) + [OrbitDB](https://orbitdb.org)
  in the plugin. One op-log record per file (path, content CID, mtime, tombstones);
  Merkle-CRDT merging makes concurrent edits on two devices conflict-free; the
  snapshot layer in this repo becomes the bootstrap/restore path. The RPC seam is
  the kubo client in `src/kubo` — that's the only thing Phase 2 replaces.
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

## License

MIT, copyright Prometheus AGS. See `LICENSE`. Release history: `CHANGELOG.md`.
