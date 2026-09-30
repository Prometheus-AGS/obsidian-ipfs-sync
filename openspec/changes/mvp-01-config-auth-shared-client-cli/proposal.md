## Why

The plugin hardcodes one RPC URL and a bearer-only token, the CLI does not exist, and every kubo call goes through a private `ipfsRequest()` inside `src/main.ts`. Every later change (delta publish, pull, encryption) needs one shared client that works in both the Obsidian WebView and Node 24, with endpoints and auth that operators can configure. The node is shared production infrastructure, so the configuration must also make it impossible to touch keys or MFS paths this project does not own. Phase goals 1 and 3; enables 2, 4, 7.

## What Changes

- New `SyncConfig` model: separate RPC (write) and gateway (read) endpoints, each with URL and port; publication key; MFS root; auth scheme none | basic | bearer (static or JWT) | custom header.
- New node-safety validators: MFS root confined to `/obsidian-vault-sync`; publication key name pattern and ownership classification; pre-encryption fixture-vault guard.
- New shared `src/kubo/` client (WebView-safe, no Obsidian or Node imports): all args in the query string, project-owned `files/write` sending multipart field `data`, auth applied to RPC and gateway.
- New `cli/` Node 24 entry with `ipfs-sync status`.
- Toolchain: pnpm 12.8.1 via corepack, esbuild 0.28.2, obsidian types 1.13.1, vitest 5.0.2 + vite 7, second esbuild target for the CLI. **BREAKING**: `package-lock.json` removed; `npm run build` becomes `pnpm build`.
- Constraints: `build-passes` and `build_health_command` move to `pnpm build`; console/any/secret checks extended to `cli/`; new `no-python`; `never-sync-workspace-state` check moves off `scripts/excludes.txt` in mvp-02 (not here).

## Capabilities

### New Capabilities
- `sync-config`: endpoint, auth, publication-key and MFS-root configuration with node-safety and fixture-guard rules.
- `kubo-client`: the single shared client for kubo RPC and gateway access.
- `cli-status`: the `ipfs-sync status` command, the first runnable CLI surface.

### Modified Capabilities
<!-- none: openspec/specs/ is empty -->

## Impact

- Code: new `src/core/config/`, `src/kubo/`, `cli/`; `esbuild.config.mjs`, `package.json`, `tsconfig.json`; `.kbd-orchestrator/constraints.md`, `project.json`.
- Dependencies: `kubo-rpc-client` 7.1.0 (runtime); `esbuild`, `obsidian` (types), `vitest`, `vite` (dev).
- `src/main.ts` is untouched (mvp-04 migrates the plugin). The plugin must still build and load.
- Node: writes only under `/obsidian-vault-sync/.probe/`; no key operations.
