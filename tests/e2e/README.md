# E2E suite — encrypted sync loop against the live node

This directory holds the end-to-end suite for change `mvp-09-e2e-sync-fixture`. It drives the
real built CLI (`dist/cli/ipfs-sync.mjs`) as spawned child processes against the live staging
node (ipfs.prometheusags.ai), through a loopback proxy that confines every mutation to the run's
own root and the suite-owned key `obsidian-vault-e2e`.

The default gate `pnpm test` never discovers these files: this config includes only
`tests/e2e/**/*.e2e.ts`, and the root `vitest.config.ts` includes `tests/**/*.test.ts`, which the
`.e2e.ts` suffix never matches. The two configs are disjoint by construction.

## How to run

The suite never builds. Build first, then run:

```
pnpm build
PATH=/opt/homebrew/bin:$PATH pnpm test:e2e
```

**Node version.** `engines.node` requires >= 24.15.0. On this machine the default shell resolves
Node 24.11.1, so the `PATH=/opt/homebrew/bin:$PATH` prefix above is mandatory. The suite refuses
fast on a wrong Node and names this fix in the refusal message.

**Live node required.** The node address and auth come from the operator's environment
(`IPFS_SYNC_RPC_URL` / `IPFS_SYNC_GATEWAY_URL` and the `IPFS_SYNC_*` auth variables); nothing is
hardcoded. A bounded read-only probe (`version`, `key/list`) runs before the first scenario. If
the node is unreachable, the suite **FAILS loudly with the node address and the error — it never
skips**. A green-with-skip summary is indistinguishable from a pass in CI logs, and this suite
exists to produce evidence, so an unreachable node means "no evidence today", reported red.

## Per-run state

Each run generates a `runId` (matching `/^[a-z0-9-]{8,}$/`) and works exclusively under:

- **Node-side run root**: `/obsidian-vault-sync/e2e-<runId>` — the only MFS path the run may
  mutate, enforced by the proxy allowlist policy (unit-tested offline in
  `tests/unit/e2e-proxy-policy.test.ts`).
- **Per-run temp directory** (outside the repository, under the OS temp dir): simulated device
  vaults, config files, and per-device state (`XDG_STATE_HOME` / `HOME`, both absolute), plus the
  passphrase file (0600 inside a 0700 subdirectory).
- **Per-machine lock file** in the OS temp dir, so two local runs never interleave.

## Cleanup semantics

The suite removes exactly its own run root — and nothing else:

- The last scenario (S5) performs the removal as an ordered step (`files/stat`, then
  `files/rm -r` of exactly the run root with bounded retries, then `files/stat` to confirm), and
  re-lists `/obsidian-vault-sync` asserting no `e2e-` prefixed entries remain.
- `afterAll` is the failure-path safety net: whether scenarios passed, failed or never ran, it
  attempts the same removal. It is idempotent (an already-removed root is detected by
  `files/stat` and skipped), and a cleanup failure there fails the suite naming the root.
- `SIGINT`/`SIGTERM`/`SIGHUP` trigger a bounded best-effort cleanup before exit.
- Automatic removal of anything else — another run's root, a pin, a key — is refused by the proxy
  policy, not by convention. A stale `e2e-<staleId>` root from a previously crashed run fails the
  suite loudly and prints the exact operator removal command for that specific root
  (`files/rm -r /obsidian-vault-sync/e2e-<staleId>`).
