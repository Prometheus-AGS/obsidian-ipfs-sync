## Why

The plugin still runs the old snapshot logic in `src/main.ts`: a private `ipfsRequest()`, one monolithic `FormData` upload of the whole vault (the goal-4 memory hazard on mobile), a single RPC URL, and a bearer-only token. mvp-01 to mvp-03 built the shared, tested engine (client, manifest, delta publish, pull) but only the CLI uses it. This change makes the plugin publish through that engine, with the settings the operator asked for, so the first Obsidian-visible release (mvp-05, v0.2.0) has one code path for both hosts. Phase goals 1, 3 and 4.

Two things get worse before they get better. First, the plugin loses its pull command here: the old tar-based pull is deleted with `ipfsRequest()`, and the new pull lands in mvp-05, so between the two changes the plugin can publish but not pull. Second, the plugin's secrets live in `data.json` inside the vault (spec 011 Q4), and unless that file is excluded from sync, the next publish would upload the bearer token to the node. This change closes that hole explicitly. v0.2.0 remains fixture-only: the plugin refuses to publish any vault without the `.ipfs-sync-fixture` marker.

There is also a toolchain reversal: `kubo-rpc-client` (adopted as cand-001) costs about 640 KB in the WebView bundle and forced a type shim. The project uses about ten simple RPC calls, so the first task replaces it with a small fetch-based caller behind the same client interface.

## What Changes

- Replace `kubo-rpc-client` with an own fetch-based `rpcCall` behind the unchanged `src/kubo` client interface; delete `kubo-rpc-client-shim.d.ts` and the dependency; the WebView bundle for `src/kubo` plus `src/core` drops below a stated size. **Reverses cand-001.**
- Move plugin logic out of `src/main.ts` into `src/plugin/`; `src/main.ts` stays the esbuild entry and re-exports the plugin. Delete `ipfsRequest()`, the monolithic upload and the old pull command.
- New Obsidian HostBridge (`src/plugin/obsidian-host-bridge.ts`) covering the `fs_*` and `kv_*` subset publish needs.
- Publish command, ribbon icon and status notice run on the `src/sync` publish engine, with progress from the EventBus.
- New plain settings tab: separate RPC and gateway URL and port, publication key, MFS root, auth scheme with per-scheme fields, exclusions editor with the effective list and `excludesHash`, owned-key display and adopt-by-ID with a confirmation dialog. Inline validation uses the mvp-01 validators.
- New settings migration from `{rpcUrl, keyName, authToken, excludedPaths, publishIntervalMinutes}`; the old default key `obsidian-vault` maps to `obsidian-vault-sync`; an existing foreign key is never adopted implicitly.
- The plugin's own `data.json` is added to the default exclusions so secrets are never published. This changes `excludesHash`.
- Pre-encryption guard applies: no marker file, no publish.
- Build output: `pnpm build` writes the plugin bundle to `dist/plugin/`, not into the operator's real vault; the dev loop keeps an opt-in vault target.
- Feature operation script `tools/feature-op-mvp-04.mjs` around a throwaway fixture vault.

## Capabilities

### New Capabilities
- `kubo-client-lite`: the dependency-free RPC caller and its size and parity requirements.
- `plugin-publish`: publish command, ribbon, status, progress, guard, key ownership, and the removal of the old code path.
- `plugin-settings`: the settings tab, validation, secrets handling and the owned-key controls.
- `settings-migration`: mapping of the old settings to the new model.
- `obsidian-host-bridge`: the Obsidian implementation of the host capabilities and its mobile-safety limits.

### Modified Capabilities
<!-- none: earlier changes' specs are not yet in openspec/specs/. The new default exclusion and the removal of kubo-rpc-client are stated in this change's own capabilities. -->

## Impact

- Code: new `src/plugin/`; `src/main.ts` becomes a re-export; `src/kubo/` internals replaced (interface unchanged); `src/sync/exclusions.ts` gains one entry; `esbuild.config.mjs`, `package.json` (remove `kubo-rpc-client`), `tsconfig.src.json` (drop the shim mapping); `tools/feature-op-mvp-04.mjs`; test config for an `obsidian` module stub.
- Removed: `src/kubo/kubo-rpc-client-shim.d.ts`, the `kubo-rpc-client` dependency, `ipfsRequest()`.
- Disjoint from mvp-08 (history store): this change owns `src/plugin/`, `src/kubo/`, `esbuild.config.mjs` and the dependency edits it makes; mvp-08 owns `cli/store/` and `src/core/store/` only.
- Node: the feature operation publishes to `/obsidian-vault-sync/mvp04-demo` with the project-owned key; no other mutation.
