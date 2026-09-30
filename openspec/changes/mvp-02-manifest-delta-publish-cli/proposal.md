## Why

Nothing in the project can publish a vault yet. mvp-01 delivered configuration, node-safety validators and a shared kubo client, but the only sync logic still lives in the plugin's monolithic `src/main.ts` and in shell scripts that re-upload everything. Delta publish is the core of the product: cost must be O(changes), not O(vault), and it must run from the CLI first so the mechanics are proven on the shared node before the plugin adopts them (mvp-04). Phase goals 1 and 2; enables mvp-03 (pull), mvp-04 (plugin publish) and mvp-08 (history store).

The uncomfortable part: this is the first change that mutates the shared production node and the first that creates an IPNS key. A wrong key or MFS path here damages other projects' data, and the existing `obsidian-vault` key is not ours. Every mutation in this change is therefore guarded by mvp-01's validators, and the default publication key changes to a new project-owned key.

## What Changes

- New manifest v1 (DESIGN §4.2) with an exact, sorted-list `excludesHash`, and sha256 change detection (size/mtime pre-filter) that runs in Node 24 and the WebView: WebCrypto up to 32 MB, incremental hashing above.
- New single exclusion module that replaces the plugin setting and the `scripts/excludes.txt` defaults. The `never-sync-workspace-state` constraint check moves to that module in this change.
- New delta publish pipeline: bounded per-file write pool into `<mfsRoot>/current/`, 8 MB chunking above 32 MB, per-write `files/stat` verification, deletions, root stat, pin of the MFS root, manifest stored as `manifest.json` and under `manifests/`, `name/publish` (ttl 5m).
- The default MFS root becomes `/obsidian-vault-sync/default`; the IPNS value is the CID of the MFS root, which holds `current/`, `manifest.json` and `manifests/`.
- New publication-key behaviour: default key becomes the project-owned `obsidian-vault-sync`; the key is created with `key/gen` only when absent; foreign keys (including the existing node key `obsidian-vault`) are refused unless the operator passes `--owned-key <id>`. **BREAKING** for anyone relying on the mvp-01 default key name `obsidian-vault`.
- New `fixtures/` synthetic-vault generator with the `.ipfs-sync-fixture` marker; publish calls the mvp-01 fixture guard.
- New typed EventBus (`file.changed`, `publish.complete`) and the full HostBridge interface (types only) in `src/core`; a Node HostBridge subset in `cli/node-host-bridge.ts`. `src/core` outside `store/` is frozen after this change.
- New command `ipfs-sync publish <vault>`.
- Toolchain (first task): `src/` is type-checked with `types: []` through a dedicated tsconfig, so Node globals and modules cannot leak into WebView-bound code; `pnpm typecheck` runs both configurations.
- The kubo client (`src/kubo`) gains `key/gen`, `pin/add`, `name/publish` and `name/resolve`, each guarded. The manifest reaches the node through the existing `files/write` wrapper, so no second multipart path is introduced.

## Capabilities

### New Capabilities
- `vault-manifest`: manifest v1 schema, `excludesHash`, sha256 change detection and the last-published state.
- `sync-exclusions`: the single exclusion list and its deterministic hash.
- `delta-publish`: the publish pipeline, node-safety enforcement on every mutation, and the `ipfs-sync publish` command.
- `publication-key`: default key name, creation-when-absent, ownership recording and foreign-key refusal.
- `event-bus`: typed events with their first producers, and the HostBridge contract with the Node subset.
- `fixture-vault`: the synthetic vault generator and marker file.
- `src-type-isolation`: type-check separation that keeps Node types out of `src/`.

### Modified Capabilities
<!-- none: mvp-01's specs are not yet in openspec/specs/, so the key-name default is stated in publication-key rather than as a delta -->

## Impact

- Code: new `src/sync/`, `src/core/events/`, `src/core/host-bridge/`, additions in `src/kubo/`, `src/core/config/defaults.ts` (default key name), new `cli/publish-command.ts`, `cli/node-host-bridge.ts`, new `fixtures/`, new `tsconfig.src.json`; `package.json` scripts, `tsconfig.json`, `.kbd-orchestrator/constraints.md` (`never-sync-workspace-state`).
- Dependencies: `@noble/hashes` (runtime; incremental sha256 for files over 32 MB, version verified against the registry at install; mvp-06 reuses it). sha256 for smaller files uses WebCrypto (`globalThis.crypto.subtle`).
- `src/main.ts` and `scripts/` are untouched (mvp-03 deletes the scripts, mvp-04 migrates the plugin).
- Node: writes only under `<mfsRoot>` (default `/obsidian-vault-sync`; feature operation uses `/obsidian-vault-sync/mvp02-demo`); creates at most one IPNS key, `obsidian-vault-sync`; pins only roots and manifests this change created. No `key/rm`, no `pin/rm`.
