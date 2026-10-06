## Why

After mvp-07b the encrypted loop works, and mvp-08 proved the history recorder against the live node — but the proof lives in one-shot feature-operation scripts (`tools/feature-op-mvp-07a.mjs`, `tools/feature-op-mvp-08.mjs`) whose results are JSON documents in a temp directory, not in a committed, re-runnable suite. The phase assessment called this out (WARNING 3: the shell-script bring-up, and now its feature-op successors, produce no committed evidence), and phase goal 6 requires an E2E fixture test that is green on demand. mvp-09 turns the harness patterns the feature ops proved into a vitest suite that drives the real CLI against the staging node and cleans up after itself.

The uncomfortable part: this suite mutates a shared production-adjacent node (ipfs.prometheusags.ai) on every run, and it runs unattended — no operator reading a plan first. Every guard the feature ops carry (allowlist proxy, owned-key validation, per-run roots, scrubbed environments) has to survive the move into `pnpm test:e2e` form, because the next person to run it will not read the 07a source first. A second exposure: the suite needs its own publication key (`obsidian-vault-e2e`), and since `key/rm` is forbidden project-wide, that key is permanent the first time the suite runs anywhere — the design records why one persistent suite-owned key is right and per-run keys are wrong.

## What Changes

- New `tests/e2e/` vitest suite that drives the built CLI (`dist/cli/ipfs-sync.mjs`) as child processes against ipfs.prometheusags.ai through a loopback allow-list proxy — the same confinement pattern as `tools/feature-op-mvp-07a/`, re-bound to this suite's own root and key.
- Each run gets its own MFS root `/obsidian-vault-sync/e2e-<runId>/` and uses the project-created publication key `obsidian-vault-e2e` (matches the `KEY_NAME_PATTERN` rule in `src/core/config/node-safety.ts:57`; created with `key/gen` only when absent, adopted only when recorded as owned, never removed — `key/rm` is forbidden project-wide).
- Scenario set, all driving the real CLI: encrypted publish → `name/resolve` → second-device pull → conflict (remote wins, dated `name (ipfs conflict YYYY-MM-DD)` copy, nothing local deleted); wrong passphrase (unlock error, nothing on disk); tampered segment (one flipped blob bit under the run's own `tamper/` folder; that file fails integrity, the rest sync). One assertion checks that the mvp-08 history recorder recorded the operations in the per-run state directory.
- Cleanup is part of the suite, not an opt-in command: the run's own root is removed (`files/rm -r` of exactly that root) on success AND on failure, best-effort on signal; the final scenario asserts `files/ls /obsidian-vault-sync` shows no `e2e-` leftovers.
- New package script `pnpm test:e2e` (this change holds the package.json write; no other change is in flight). The default gate `pnpm test` does NOT run the suite — e2e specs use the `.e2e.ts` suffix, which the root `vitest.config.ts` include pattern (`tests/**/*.test.ts`) does not match, so the offline gate stays offline with zero config edits.
- When the node is unreachable, `pnpm test:e2e` FAILS with a loud reason. It never skips silently: the suite exists to produce goal-6 evidence, and a skip is indistinguishable from green in a summary line.
- No production code changes: scope is `tests/` plus the one package.json script. The suite reuses key-agnostic machinery from `tools/feature-op-mvp-07a/` by import and the hostile `prepare-tamper` op from `tools/feature-op-mvp-07/`; everything bound to the feature ops' key or demo roots is re-declared in `tests/e2e/` (design.md decision 3).

## Capabilities

### New Capabilities
- `e2e-fixture-isolation`: per-run root and suite-owned key, the loopback proxy confinement policy, per-device state isolation, preflight refusals (Node version, build freshness, node reachability fail-not-skip), cleanup-on-success-and-failure semantics, the no-leftovers gate, and the `pnpm test:e2e` wiring.
- `e2e-encrypted-loop-scenarios`: the publish → resolve → pull → conflict scenario, the wrong-passphrase refusal, the tampered-segment integrity failure, and the in-loop history-recorder assertion.

### Modified Capabilities
<!-- none: openspec/specs/ holds no e2e capability; both deltas are ADDED -->

## Impact

- Code: new `tests/e2e/` (suite config, harness modules, one ordered spec file, README), new offline unit tests for the proxy policy under `tests/unit/`, one new script line in `package.json`. No edits to `src/`, `cli/`, `tools/`, `vitest.config.ts` or `playwright.config.ts`.
- Dependencies: none added (vitest 5.0.2 is already the runner).
- Node: on first run anywhere, `key/gen` creates the permanent key `obsidian-vault-e2e`. Each run creates and then removes `/obsidian-vault-sync/e2e-<runId>/`; the IPNS record of `obsidian-vault-e2e` is repointed every run (the key is suite-owned and disposable — no pointer-restore story, unlike the operator demo key `obsidian-vault-sync`). No `pin/rm`, no `key/rm`, ever.
- Data: per-run vaults, configs and state directories (XDG_STATE_HOME/HOME, including the PGlite history database) live in a per-run temp directory outside the repository and are deleted at run end; the operator's real state directory is never touched.
- Docs: run instructions live in `tests/e2e/README.md` (bdd-engineer path). No README.md/CHANGELOG.md/docs/ edits — mvp-10 owns those.
