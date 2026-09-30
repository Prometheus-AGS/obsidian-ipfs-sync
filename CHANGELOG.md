# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries describe what exists in the code;
anything not yet built is under "Known limitations" or not mentioned.

## [Unreleased] - 0.2.0 (fixture-only pre-release, draft)

**Release 1 is fixture-only. It must not be used on real notes.** It has no encryption. It syncs
synthetic fixture vaults only (a vault marked by a `.ipfs-sync-fixture` file), refuses any other vault,
and everything it publishes to your kubo node is readable by anyone who obtains the CID. Encryption is
planned for a later release (`mvp-06`); real notes only after it ships.

This entry is a draft. `manifest.json` and `package.json` still read 0.1.0, nothing is tagged or
published, and the in-Obsidian demonstration that defines the release (a pull with a real conflict in
Obsidian desktop on macOS) has not been recorded yet. If that demonstration does not pass, this
version is not released.

### Added

Increment mvp-01, configuration, auth, shared client, CLI:
- `ipfs-sync status`: node identity, MFS listing, gateway fetch, write probe and key state.
- Separate RPC (write) and gateway (read) endpoints, each with URL and optional port. Auth schemes: none,
  basic, bearer (static token or JWT), custom header. Flags override `IPFS_SYNC_*` environment variables,
  which override the config file; the config file rejects secrets.
- Node-safety checks: MFS root confined to `/obsidian-vault-sync`, publication key name pattern
  (`^obsidian-vault(-[a-z0-9-]+)?$`), and the fixture-vault guard.
- One shared kubo client (`src/kubo`) used by the plugin and the CLI. It works around the node's quirks:
  arguments in the query string, `files/write` as multipart with field `data`, `name/resolve` with
  `nocache=true`.

Increment mvp-02, manifest and delta publish:
- Manifest v1 with per-file sha256 and an `excludesHash`; change detection by size/mtime pre-filter, then sha256.
- `ipfs-sync publish <vault>`: sends only changed files to `<mfsRoot>/current/`, verifies each write,
  pins the MFS root, stores `manifest.json` and `manifests/<cid>.json`, and publishes the root CID to the IPNS key.
- Project-owned IPNS key `obsidian-vault-sync`, created only when absent and recorded under `ownedKeys`.
  A foreign key is refused unless its ID is passed with `--owned-key`.
- One shared exclusion list. Defaults: `.trash/`, `.ipfs-sync/`, `.ipfs-sync-fixture`, `.DS_Store`,
  `.obsidian/workspace.json`, `.obsidian/workspace-mobile.json`, `.obsidian/workspace.json.bak`,
  `.obsidian/graph.json`, `.obsidian/cache`, `.obsidian/plugins/` (whole folder, so plugin code and
  plugin data stay on the device), `.obsidian/plugins/ipfs-sync/data.json`, `node_modules/`, `.git/`.
- Synthetic fixture vault generator: `pnpm fixture:generate <dir> [--seed <n>]`.

Increment mvp-03, delta pull and conflict policy:
- `ipfs-sync pull <vault>`: resolves the IPNS name, reads the manifest through the gateway, and fetches only
  missing or changed files. Each file is hashed against the manifest and renamed into place only on a match.
  Options `--name`, `--manifest <cid>` (restore an earlier snapshot) and `--manifest-file <path>`.
- Conflict policy: remote becomes canonical; a local file that differs from both the last synced state and the
  remote is kept as `name (ipfs conflict YYYY-MM-DD).ext`. Pull never deletes local files; remote deletions are reported only.
- Pull path policy: manifest paths that are absolute, contain `..` or empty segments, backslashes or control
  characters, lie inside `.ipfs-sync/` or `.obsidian/plugins/`, or match the exclusion list are refused and
  counted as failed. The CLI also refuses to write through a symbolic link.
- CLI destination guard: pull writes only into an absent, empty or marked directory.

Increment mvp-04, plugin publish and settings:
- **IPFS Sync: Publish vault** command, ribbon icon and status notice, on the same publish engine as the CLI.
  Publish requires the fixture marker.
- Settings tab: RPC and gateway URL and port, publication key, MFS root, auth scheme with per-scheme fields,
  exclusion list editor, owned-key display and adopt-by-ID with a confirmation dialog, optional auto-publish interval.
- Settings migration from the old flat settings; the old default key name `obsidian-vault` maps to `obsidian-vault-sync`,
  and an existing foreign key is never adopted implicitly.
- Node requests go through Obsidian's `requestUrl`, because the node's CORS rules block the WebView's `fetch`.

Increment mvp-05, plugin pull and conflict:
- **IPFS Sync: Pull vault** command and a Pull ribbon icon, with progress in a notice and the status bar and a
  summary of fetched, unchanged, conflict, failed and remote-deletion counts. It names up to three conflict copies and says
  "incomplete" when any file failed. Pull is read-only against the node.
- Same pull engine as the CLI: same verification, atomic writes, conflict copies and path policy.
- Pull target: the **pull name** setting (an IPNS key ID; `/ipns/` prefix accepted), else the ID of the owned
  publication key, else the pull stops and tells you to set a pull name.
- Destination guard for the plugin: Pull writes only into a vault that has the fixture marker or no files outside
  `.obsidian/` and `.ipfs-sync/` (the marker is then created). Any other vault is refused before any request.
- Every open editor is saved before files are compared, so an edit that exists only in the editor is treated as a local edit.
- Publish and Pull do not run at the same time in one vault.
- **Catch up on load** setting (per device, off by default): one pull after the workspace layout is ready.
- **Read cap** setting: default 64 MB per file, 8 to 1024. A file above the cap fails by name; other files continue.
- Settings show the last pull and last publish (counts, CIDs, timestamps only).
- Settings model moved to version 3, migrating from version 2 without changing existing values.

### Changed

- Build tooling is pnpm (`pnpm build`, `pnpm dev`, `pnpm test`, `pnpm typecheck`); `package-lock.json` is gone. Node 24.15 or later.
- `pnpm build` writes the plugin to `dist/plugin/` and the CLI to `dist/cli/ipfs-sync.mjs`; it does not write into a vault.
  `pnpm dev` writes into a vault only when `OBSIDIAN_PLUGIN_DIR` is set.
- Default publication key is `obsidian-vault-sync`, default MFS root `/obsidian-vault-sync/default`.
- The plugin's own `data.json` (which holds credentials) was added to the default exclusions, which changes the `excludesHash`.
- The `kubo-rpc-client` dependency was replaced by a small fetch-based caller behind the same client interface.
- Minimum Obsidian version is 1.12.3.
- The project is MIT licensed (copyright Prometheus AGS).

### Removed

- `scripts/publish.sh`, `scripts/pull.sh` and `scripts/excludes.txt`. Use `ipfs-sync publish` and `ipfs-sync pull`.
- The plugin's old whole-archive pull and its `ipfsRequest()` helper.

### Known limitations

- No encryption. Fixture vaults only; other vaults are refused. Everything published is readable by anyone with the CID.
- The plugin cannot detect symbolic links: Obsidian's file adapter has no `lstat`. Do not place symlinks in a synced vault.
- Per-file read cap (64 MB by default, 8 to 1024 MB configurable); files are read whole, so large files cost memory.
- Remote deletions are not applied on pull; they are reported and the local file stays.
- Plugin writes replace an existing file by removing it and then renaming a temporary file, which is not atomic.
  A crash in that window could leave the file missing until the next pull. Untested.
- Mobile is not verified. Windows and Linux are not verified. The demonstration target is Obsidian desktop on macOS, and it has not been recorded yet.
- An authenticated (auth-protected) kubo endpoint has not been exercised with the plugin.
- Requires Obsidian 1.12.3 or later.
- Snapshot sync only: no multi-writer merge, no history browser, no AI layer.

## [0.1.0]

Version in `manifest.json` before this work. Not documented in detail here.
