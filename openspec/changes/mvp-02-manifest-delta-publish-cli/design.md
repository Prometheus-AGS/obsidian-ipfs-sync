## Context

mvp-01 built `SyncConfig`, the node-safety validators (`validateMfsRoot`, `assertMfsMutationPath`, `classifyKey`, `assertKeyOwnedForPublish`, `assertFixtureVault`), the shared `KuboClient` (read calls, `filesWrite` with multipart field `data`, `filesRm`, `keyList`, gateway fetch) and `ipfs-sync status`. It deliberately did not create keys or publish names. The pre-existing shell scripts still upload everything. DESIGN.md §4.1 to §4.3 describes the layout, manifest and publish steps this change implements. The shared node has three foreign keys (`consult-capture`, `gomark-relay-lab`, `prince-live`), a foreign key named `obsidian-vault` (ID `k51qzi5u...74t0vzj3ina`), and an off-limits tree `/obsidian-vault-staging`. Plaintext publishing is allowed only for synthetic fixtures (plan, pre-encryption rule). See proposal.md.

## Goals / Non-Goals

**Goals:**
- Publish cost proportional to changed files, provable with a two-run demo.
- Every node mutation passes a validator; nothing outside the project namespace is touched.
- Shared code (`src/sync`, `src/core`) runs unchanged in Node 24 and the WebView so mvp-04 only adds a host.

**Non-Goals:**
- No pull, no conflict policy, no `name/resolve`-driven sync (mvp-03). `name/resolve` exists here only for verification.
- No plugin code, settings tab or Obsidian HostBridge (mvp-04).
- No encryption, no manifest v2 (mvp-06). Manifest v1 is plaintext and fixture-only.
- No history store (mvp-08), no deleting `scripts/` (mvp-03), no pin garbage collection.

## Decisions

1. **Layout.**
   - `src/sync/`: `exclusions.ts`, `manifest.ts`, `scan.ts` (enumerate), `hash.ts` (sha256: WebCrypto up to 32 MB, incremental above), `diff.ts`, `pool.ts`, `chunked-write.ts`, `publish.ts` (orchestration).
   - `src/core/events/`: typed EventBus. `src/core/host-bridge/`: the interface, types only. Both are frozen after this change (`src/core` outside `store/`).
   - `src/kubo/`: additions for `key/gen`, `pin/add`, `name/publish`, `name/resolve`.
   - `cli/`: `publish-command.ts`, `node-host-bridge.ts`.
   - `fixtures/`: generator. Files are kebab-case (versions.toml).
   - Layering stays inward: `cli` depends on `src/sync`, which depends on `src/kubo` and `src/core`; `src/core` depends on nothing.

2. **Toolchain first.** Task 1 adds `tsconfig.src.json` (`include: src/**`, `types: []`, DOM libs kept because `fetch`, `FormData` and `Blob` are WebView APIs) and reduces `tsconfig.json` to the Node-typed set. `pnpm typecheck` runs both. Verification is a scratch `src/` file importing `node:fs` that must fail the src check, then is deleted. Risk: `kubo-rpc-client` typings may reference Node types; `skipLibCheck` is already on, and if a real error appears the fix is confined to `src/kubo` (task 1.2 records it).

3. **Exclusions.** One module holding the default list and a pure `isExcluded(path)`. `excludesHash` = sha256 hex of the entries sorted by code unit and joined with `\n` (no trailing newline). The exact form is fixed by a unit test with a literal expected hash so mvp-03 can compare hashes across devices. Matching rules are in the sync-exclusions spec. The plugin setting for extra user exclusions is not built here; the module accepts an extra-entries argument so mvp-04 can pass the setting.

4. **Manifest and local state.** The manifest holds exactly the DESIGN §4.2 fields. mtime is not part of the manifest; it lives in a local state file `<vault>/.ipfs-sync/state.json` written through the HostBridge: `{ manifest, mtimes: {path: ms}, key }`. The state file is excluded by `.ipfs-sync/` and has no credentials. Serialisation uses sorted keys and a fixed indent, so equal states give equal bytes.

5. **Change detection and hashing.** Enumerate via the HostBridge `fs_*` list/stat. For each non-excluded file: if size and mtime match the state, reuse the recorded sha256; otherwise hash. Files of 32 MB or less are read whole and hashed with `crypto.subtle.digest('SHA-256')`. Files above 32 MB are read in 8 MB range reads and fed to an incremental sha256 from `@noble/hashes`, because WebCrypto has no incremental digest and a whole-file read is unsafe on mobile. `@noble/hashes` is pure JS, WebView-safe, and mvp-06 reuses it; the engineer verifies the version against the registry with `npm view` at install and pins it. The incremental digest must equal the one-pass digest, proven by a test on a 40 MB buffer.

6. **Write pool.** A small in-repo pool (no new dependency): concurrency 6, floor 4 documented as the range the plan allows. Each task: write (one request, or chunks with `offset` for >32 MB: first chunk `truncate=true`, later chunks `truncate=false`, each chunk sequential inside the task), `files/stat`, compare size, record the CID from the stat. Failures collect and abort scheduling of new work; in-flight writes finish.

7. **Ordering and atomicity.** MFS `current/` is mutated in place, so a failed publish leaves partial content in `current/` but the IPNS record and the local state do not advance. Rerun converges because change detection compares against the state, not against MFS. Order: writes and verify, then removals, then `files/stat <mfsRoot>/current` (this CID becomes the manifest's `rootCID`, read before the manifest exists, so nothing is self-referential), write the manifest to `manifest.json` and `manifests/<currentCID>.json`, `files/stat <mfsRoot>`, `pin/add` of that CID, `name/publish`, then update local state. Removals run after writes so a rename does not lose data if the run dies midway.

8. **Layout and manifest storage without `add`.** Under `<mfsRoot>` (default `/obsidian-vault-sync/default`): `current/` (vault tree), `manifest.json` (latest manifest, sibling of `current/`), `manifests/<currentCID>.json` (immutable history). IPNS publishes the CID of `<mfsRoot>` itself, so a reader does `name/resolve` -> `cat <root>/manifest.json` -> fetch `<root>/current/<path>` (mvp-03 pull). This supersedes the plan text "publish the `current/` root" and DESIGN §4.2/§4.3 (`.ipfs-sync.manifest.json` at the snapshot root); DESIGN.md is synced in mvp-10. The plan says "add and mirror the manifest". `kubo-rpc-client`'s `add` uses its own multipart encoding, and the proxy's field-name quirk has only been proven for `files/write`. To keep the single-`files/write`-path rule, both manifest files are written with the existing wrapper; `pin/add` of the `<mfsRoot>` CID pins them with the tree. One fewer proxy risk, same outcome.

9. **Publication key flow.** `keyList` -> `classifyKey(name, keys, ownedIds ∪ --owned-key)`. `absent`: `key/gen` (name validated by `assertValidKeyName`), write the returned ID to `ownedKeys` in the config file (`--config`, default `./ipfs-sync.config.json`; created with only `ownedKeys` when missing) through the HostBridge, re-classify, continue. If the write fails, stop before `name/publish` and print the ID and the `--owned-key` value. `owned`: continue. `foreign`: `assertKeyOwnedForPublish` throws. `--owned-key` is never persisted. Two defaults in `src/core/config/defaults.ts` change (edits to `src/core/config` land in task 2.2, before the freeze): `DEFAULT_PUBLICATION_KEY` becomes `obsidian-vault-sync`, and a new `DEFAULT_MFS_ROOT` = `/obsidian-vault-sync/default` replaces `MFS_BASE` as the default root. `MFS_BASE` stays as the confinement base. The narrower default keeps the published tree free of `publish-real-20260929` and `.probe`. Existing mvp-01 tests that assert the old defaults and must be updated: `tests/unit/config.test.ts` (~line 151 `mfsRoot` default; lines ~203-204 if they assert defaults), `tests/unit/cli-run.test.ts` (~lines 142 `mfs /obsidian-vault-sync: 1 entry` and 145 `key obsidian-vault: absent`), plus the `status` probe path and listing, which now target `/obsidian-vault-sync/default`. Task 2.2 checks that `status` still works when that root does not yet exist.

10. **name/publish.** Value is `/ipfs/<CID of mfsRoot>`, ttl `5m`, key = configured name. The exact RPC argument set (`arg`, `key`, `ttl`, `lifetime`, `resolve`, `allow-offline`) is confirmed from the Kubo RPC docs and the library typings at implementation time rather than assumed here.

11. **Events.** `file.changed` and `publish.complete` are produced by `src/sync/publish.ts` through an injected bus. `publish.complete` is emitted after `name/publish` and the state write succeed. Listener errors are caught and reported through the bus's own error channel; they never abort a publish.

12. **HostBridge.** The interface is declared in full from the surface named in specs 003/005/008: `fs_*`, `net_*`, `kv_*`, `agent_*`, plus `time_now`, `env_read`, `shell_exec` where the guest ABI names them. Docs name families but not exact members, so member signatures are fixed in task 3.2 and reviewed before the `src/core` freeze. The engineer proposes the member signatures and records them in this file under "HostBridge members" when task 3.2 completes; the lead signs off after the report and work does not block on it. The Node implementation covers the `fs_*` subset publish needs (list, stat, read, range read, write, mkdir) and `kv_*` backed by files under `.ipfs-sync/`. Other families throw a typed not-implemented error.

13. **Fixtures.** `fixtures/generate-fixture-vault.ts` builds a deterministic vault from a seed (folders, Markdown notes, one binary attachment, one `.trash/` entry, and the marker). It refuses non-empty targets without the marker. It runs under Node 24.15 and is invoked by `pnpm fixture:generate <dir>`; if native type stripping cannot run it, task 5.1 builds it with the existing esbuild config instead. It has its own file list for tests to assert against, so the generator is checked without the node.

14. **Publish command output.** Progress lines and the final `N written, M removed` line go through `CliIo` (`process.stdout`/`stderr` in production). `--show-request` from mvp-01 works for publish unchanged.

15. **Constraint move.** `never-sync-workspace-state` becomes a check that greps the exclusion module for `.trash/`, `workspace.json` and `.ipfs-sync/`. It changes in the same commit that creates the module (task 2.2). `scripts/excludes.txt` stays until mvp-03.

## Risks / Trade-offs

- [Shared production node: a bug here writes to the wrong place] -> every mutation goes through mvp-01's validators; the feature operation uses an isolated root `/obsidian-vault-sync/mvp02-demo`; unit tests assert refusal for the staging root and foreign keys with a stub fetch that records requests.
- [`obsidian-vault` key on the node is foreign] -> new project key `obsidian-vault-sync`; the old key is used only with `--owned-key <id>`. Trade-off: the IPNS name changes for anyone who already publishes to `obsidian-vault`, so existing pointers do not move. Acceptable: no plaintext real vault may publish before mvp-06 anyway.
- [Pins accumulate: every publish pins a new root and this change never calls `pin/rm`] -> storage grows with history, matching the "free history" idea in DESIGN §4.1. Pruning is deferred and needs its own ownership-safe design.
- [Partial `current/` after a failed publish] -> IPNS and local state do not advance; rerun converges (decision 7). A reader resolving the key never sees the partial tree.
- [`@noble/hashes` is a new dependency] -> pure JS, no native code, reused by mvp-06; version verified at install.
- [`name/publish` latency through the proxy] -> not measured yet. The CLI timeout for this call is decided from the feature operation's observed time; if it exceeds the default request timeout the change records it as a finding rather than adding retries.
- [Freezing `src/core` too early] -> the HostBridge member list is the risky part; task 3.2 is a non-blocking checkpoint and later changes may add members through a spec delta only.
- [Untested against the proxy] -> `key/gen`, `pin/add`, `name/publish` through the proxy are first exercised in the feature operation. Until then they are unverified.

## Migration Plan

Additive except the default key name. Rollback: `git revert`; the generated `obsidian-vault-sync` key and the `/obsidian-vault-sync/mvp02-demo` tree remain on the node as harmless project-owned leftovers. Their removal is a manual operator action (this project never calls `key/rm` or `pin/rm`); a demo-tree `files/rm` under the project's own root is allowed and recorded in the feature-operation notes.

## Feature Operation

One process, one command: `node tools/feature-op-mvp-02.mjs`, which drives the built CLI (`dist/cli/ipfs-sync.mjs`) so a cadence checkpoint can run a single command. It passes `--config` pointing at a STABLE file outside the repo, `<os tmpdir>/ipfs-sync-feature-ops/config.json` (directory created if needed), so the repo stays clean and the generated key ID survives between runs: the first run creates the key and records its ID there, later runs (and the mvp-03 script, which reuses the same file) find it owned. If the key already exists on the node but is not in that file (for example the file was lost), the script does NOT adopt it: it fails before any mutation with a message telling the operator to re-run with `--owned-key <id>`. Against the shared node, mfs root `/obsidian-vault-sync/mvp02-demo`, it:

1. Generates a fixture vault in a temp directory and publishes it. Expect the key `obsidian-vault-sync` created once (if absent), its ID written to the temp config `ownedKeys`, and `N written, 0 removed`.
2. Edits one note and publishes again. Expect `1 written, 0 removed`.
3. Runs `name/resolve` on the key: the result is the CID of `/obsidian-vault-sync/mvp02-demo`. Fetches `<root>/manifest.json` through the gateway and asserts it lists the edited file with its new sha256, and that its `rootCID` equals the CID of `<root>/current`.
4. Runs the refusal cases: a directory without the marker and `--mfs-root /obsidian-vault-staging` each assert that no request was sent; `--key obsidian-vault` without `--owned-key` asserts that no mutating request was sent (exactly one read-only `key/list` is needed to learn that the key is foreign, so "no request" is not achievable for that case; the case is skipped if the node has no `obsidian-vault` key, because running it would then create one).
5. Prints each step's observed result and exits nonzero on any failed assertion. It reports honestly what stayed unverified (for example `name/publish` timing through the proxy).

## Open Questions

Documented, not blockers (lead decision 2026-09-29):

- **Pins accumulate.** Each publish pins a new `<mfsRoot>` CID and this change never calls `pin/rm`. Pruning needs its own ownership-safe design.
- **`name/publish` latency and argument set.** Not measured through the proxy. Arguments are confirmed from the Kubo RPC docs at implementation; the timeout is decided from the feature operation's observed time.
- **Exclusion semantics.** Bare-name entries match at any depth in this spec; the old `scripts/excludes.txt` semantics were not confirmed. Task 2.1 checks against `scripts/publish.sh`.
- **HostBridge members.** Proposed by the engineer in task 3.2 and recorded here under "HostBridge members"; lead sign-off after the report.

Resolved by the lead: the manifest is discoverable from the resolved root (decision 8); large files hash incrementally with `@noble/hashes` (decision 5); `ownedKeys` persists in the CLI config file.

## HostBridge members

Proposed by ipfs-engineer in task 3.2 for lead sign-off; declared in `src/core/host-bridge/host-bridge.ts` (types only). Publish itself uses `fs.list/stat/read/readRange/write`, `kv.get/set` and `timeNow`; `envRead` supplies the device name. Everything else is the minimum that the families named in docs 003/005/008 need to exist as a contract. All I/O members are `Promise`-returning; paths are host-root-relative, `/`-separated, without `..`.

| Member | Signature | Guest ABI name | Node CLI (this change) |
| --- | --- | --- | --- |
| `fs.list` | `(dir: string) => Promise<readonly {name, kind: "file"\|"directory", size, mtimeMs}[]>` | `fs_list` | implemented (symlinks and special files skipped) |
| `fs.stat` | `(path) => Promise<{kind, size, mtimeMs} \| undefined>` | `fs_stat` | implemented |
| `fs.read` | `(path) => Promise<Bytes>` | `fs_read` | implemented |
| `fs.readRange` | `(path, offset, length) => Promise<Bytes>` | `fs_read_range` | implemented |
| `fs.write` | `(path, data: Bytes) => Promise<void>` (creates parents) | `fs_write` | implemented |
| `fs.mkdir` | `(path) => Promise<void>` (recursive) | `fs_mkdir` | implemented |
| `fs.remove` | `(path) => Promise<void>` (one file, missing is ok) | `fs_remove` | implemented |
| `net.fetch` | `({url, method?, headers?, body?, timeoutMs?}) => Promise<{status, headers, body}>` | `net_fetch` | not implemented (typed error) |
| `kv.get` / `kv.set` / `kv.delete` | `(key) => Promise<Bytes \| undefined>` / `(key, value: Bytes) => Promise<void>` / `(key) => Promise<void>` | `kv_get`/`kv_set`/`kv_delete` | implemented, files under `<vault>/.ipfs-sync/` |
| `kv.list` | `(prefix) => Promise<readonly string[]>` | `kv_list` | implemented |
| `agent.list` | `() => Promise<readonly {id, name, local}[]>` | `agent_list` | not implemented (typed error) |
| `agent.invoke` | `({agentId, input, context?}) => Promise<{output}>` | `agent_invoke` | not implemented (typed error) |
| `timeNow` | `() => number` (ms since epoch) | `time_now` | implemented |
| `envRead` | `(name) => string \| undefined` | `env_read` | implemented (`process.env`) |
| `shellExec` | `({command, args, timeoutMs?}) => Promise<{exitCode, stdout, stderr}>` | `shell_exec` | not implemented (denied) |

`Bytes` is `Uint8Array<ArrayBuffer>`. KV keys are 1-128 characters of `[A-Za-z0-9._-]`, starting with a letter or digit, so a host can map them to file names or IndexedDB keys without escaping; the publish state lives under the key `state.json`. Open points for sign-off: (1) `agent.invoke` is request/response, not a stream, so AG-UI event streaming needs a spec delta; (2) `fs.remove` is only used by later changes but is included so the frozen contract does not need a delta for pull/clean-up; (3) there is no `fs.rename` or `fs.copy`.
