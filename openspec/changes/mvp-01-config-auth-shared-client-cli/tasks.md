## 1. Toolchain and constraints

- [x] 1.1 Enable corepack pnpm 12.8.1, run `pnpm import`, delete `package-lock.json`, set `packageManager`; verify `pnpm install --frozen-lockfile` succeeds and `versions.toml` pins (typescript 7.0.2, node 24.15.0) still hold
- [x] 1.2 Bump esbuild 0.28.2 and obsidian 1.13.1, add vite 7 and vitest 5.0.2 dev deps, add `kubo-rpc-client` 7.1.0; verify installed versions with `pnpm ls` and confirm each against the registry
- [x] 1.3 Update `.kbd-orchestrator/constraints.md` and `project.json` (`build-passes` and `build_health_command` to `pnpm build`; console/any/secret greps cover `cli/`; add `no-python`); verify by reading the diff

## 2. Config model

- [x] 2.1 Implement `src/core/config` types, defaults, endpoint composition (URL + port) and auth union with redaction; verify `pnpm typecheck` passes
- [x] 2.2 Implement node-safety validators (MFS root, key name, key classification, fixture guard) as pure functions; verify with a unit table covering `/obsidian-vault-staging`, `..` traversal, `consult-capture`, `gomark-relay-lab`, `prince-live`, foreign-ID key
- [x] 2.3 Implement JWT `exp` warning and secret resolution (flags, `IPFS_SYNC_AUTH_*` env, config file that rejects secret keys); verify with unit cases per scheme

## 3. Shared client

- [x] 3.1 Implement `src/kubo` auth-header builder and typed errors (401/403 to auth error); verify each scheme produces the expected header from a stub request
- [x] 3.2 Implement the client on `kubo-rpc-client` for id, version, files ls/stat/rm, key/list, plus gateway `fetch by CID`; verify all args appear in the query string using a stub fetch
- [x] 3.3 Implement the project-owned `files/write` wrapper sending multipart field `data`; verify with a stub fetch that the field name is `data`
- [x] 3.4 Add a build-time import probe (throwaway entry) that bundles `src/kubo` and `src/core` for the WebView target; verify the bundle contains no Node built-in imports and record the size delta

## 4. CLI

- [x] 4.1 Add the second esbuild target and `cli/main.ts` argument parsing (flags, env, config file) with `--show-request`; verify `pnpm build` emits `dist/cli/ipfs-sync.mjs` and `--help` runs
- [x] 4.2 Implement `ipfs-sync status` (peer ID, version, MFS listing, gateway fetch, write probe, key state) using only stdout/stderr writes; verify unsafe `--mfs-root` and `--key` exit nonzero before any request
- [x] 4.3 Run the phase feature operation: `status` against the staging node with explicit RPC/gateway URL+port and bearer settings; record the output and the honest unverified 401/403 note; verify the plugin `main.js` still builds
