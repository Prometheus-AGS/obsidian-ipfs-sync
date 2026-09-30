## Context

`src/main.ts` (426 LOC) holds all sync logic, a private `ipfsRequest()`, and settings `{rpcUrl, keyName, authToken}`. The prometheusags proxy drops form-encoded args and requires the `files/write` multipart field to be `data` (README, node quirks). `kubo-rpc-client` 7.1.0 already encodes args as URL search params but sends `file`/`file-N` for `files/write` (verified in its source at plan time). The node is shared: existing IPNS keys `consult-capture`, `gomark-relay-lab`, `prince-live`; `/obsidian-vault-staging` is off-limits (constraints.md). See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**
- One client module both runtimes import; proxy quirks in exactly one place.
- Config validation that fails closed on anything outside the project's node namespace.
- A CLI that exercises the whole config-to-node path.

**Non-Goals:**
- No delta sync, manifest, or exclusions (mvp-02).
- No plugin migration or settings UI (mvp-04). `src/main.ts` stays as is.
- No key creation and no `name/publish` (mvp-02).
- No keychain, UCAN or encryption.

## Decisions

1. **Layout.** `src/core/config/` (types, validators, defaults, redaction), `src/kubo/` (client, auth, errors), `cli/` (entry, arg parsing, status command). `cli/` sits outside `src/` so the `webview-safe-bundle` grep stays a plain scan of `src/` and Node built-ins can never reach the plugin. Files are kebab-case (versions.toml).
2. **Client construction.** Typed calls (`id`, `version`, `files/ls`, `files/stat`, `files/rm`, `key/list`) go through `kubo-rpc-client` `create({ url, headers })`. `files/write` is our own `fetch` + `FormData` with field `data`, args in the query string. *Alternative:* skip the library and write every call by hand. Rejected: the library covers ~40 endpoints later phases need, and the adoption decision (cand-001) stands. Check at build: the WebView bundle size delta; if the library pulls in Node-only code, fall back to a hand-written `rpcCall` with the same interface.
3. **Ports.** `url` plus optional `port`; composed with the URL parser. A URL that already has a different explicit port is an error, not silently overridden.
4. **Auth as a discriminated union** `{kind: 'none'|'basic'|'bearer'|'header'}`. JWT is `bearer`; the client decodes `exp` for a warning only and never verifies signatures. Endpoint override optional. Secrets resolve from flags, then `IPFS_SYNC_AUTH_*` env; the CLI config file (`--config`, default `./ipfs-sync.config.json`) may hold endpoints and non-secret fields only, and loading rejects a secret key in it.
5. **Precedence:** flags > env > config file > defaults. Defaults: RPC `https://ipfs.prometheusags.ai`, gateway same host, `mfsRoot` `/obsidian-vault-sync`, key `obsidian-vault`.
6. **Key ownership.** Pure functions: `isValidKeyName`, `classifyKey(name, nodeKeys, ownedIds)`. `ownedIds` comes from config (`ownedKeys`), populated by mvp-02's key creation. Nothing here mutates keys.
7. **Fixture guard.** Pure `assertFixtureVault(hasMarker)`; mvp-02's publish calls it. Removed by mvp-06.
8. **Toolchain.** pnpm via `packageManager` + corepack; `pnpm import` from `package-lock.json` to keep resolved versions, then delete the lock file. Second esbuild target: `platform: node`, `format: esm`, `target: node24`, entry `cli/main.ts`, out `dist/cli/ipfs-sync.mjs` with a shebang banner; `bin` in package.json. tsconfig `include` adds `cli/**/*.ts`; keep `module: Node16` (docs/011 Q2).
9. **Output.** CLI writes through `process.stdout.write` / `process.stderr.write`. The constraint greps cover `cli/`.

## Risks / Trade-offs

- [kubo-rpc-client drags Node-only code into the WebView bundle] → measure at build; fallback in decision 2. The plugin bundle is unaffected in this change because `src/main.ts` does not import `src/kubo/` yet, so this risk is only visible through a build-time import probe (task 3.4).
- [Unauthenticated staging node cannot show a 401/403] → auth rejection handling is proven by unit test with a stub fetch and reported as unverified end-to-end (plan: honest "unverified").
- [Vite 7 / vitest 5 / esbuild 0.28 bumps break the obsidian esbuild config] → bump esbuild first, build, then the rest.
- [TS 7 native compiler behaves differently from 5.x on `tsc --noEmit`] → run the type gate immediately after the tsconfig change; fix or report.

## Migration Plan

`pnpm import` → remove `package-lock.json` → set `packageManager` → update constraints in the same commit as the switch. Rollback: `git revert` the change; `package-lock.json` returns with it.

## Open Questions

- Does `key/list` on the proxy return key IDs (needed for classification)? Checked by the status feature operation; if not, classification degrades to `foreign` for any name match and status says so.
