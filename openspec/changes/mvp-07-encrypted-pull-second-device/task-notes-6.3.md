# Task 6.3 phase-boundary gate record (ipfs-engineer, 2026-10-02)

Run-only. No source, test, doc or config file changed; nothing committed; kbd-apply not called; the shared node was never contacted (feature-op ran only `--dry-run` and `--local-stub`). Writes: node_modules (install), dist/ (build), this file.

Load: `uptime` showed load averages 88-133 (1 min) during the run. No test timed out, so no rerun was needed and no timeout was raised.

## Result summary

| # | Item | Result |
|---|------|--------|
| 1 | `pnpm install --frozen-lockfile` | PASS, exit=0 |
| 2 | `pnpm typecheck` | PASS, exit=0 |
| 3 | `pnpm test` | FAIL, exit=1 (1 failing test) |
| 4 | `pnpm build`, `pnpm probe:webview` | PASS, exit=0 / exit=0 |
| 5 | constraint greps | 5 PASS, 1 literal-check FAIL (never-sync-workspace-state), see below |
| 6 | `pnpm audit` | PASS-by-rule: only the accepted moment advisory, exit=1 (tool exits 1 on any finding) |
| 7 | `vitest run tests/integration` | PASS, exit=0 |
| 8 | feature-op check, dry-run, local-stub, tamper | PASS (4 of 4) |
| 9 | `checkDistBundles` | PASS |
| 10 | tests added/changed list | attached |

## 3. Full suite

`pnpm test; echo exit=1`

    Test Files  1 failed | 156 passed (157)
         Tests  1 failed | 2866 passed | 1 skipped (2868)
      Duration  72.37s

Failing test (deterministic assertion, not a timeout):

- `tests/unit/encrypted-publish.test.ts` > "encrypted publish: first publish > issues the requests in the specified order and publishes exactly the verified root CID with ttl 5m" (line 45)
  - AssertionError: received 32 calls, expected 31. The received sequence has one extra request, `stat <root>/manifest.enc`, immediately before `write <root>/manifest.enc` (after `stat <root>/manifests/0000000000000001-<cid>.enc`).
  - Production code issues a pre-write stat of `manifest.enc` that the pinned request order in this (modified, pre-existing) test does not list. Either the test's expected order or the publish path is stale. Both files are modified in the working tree; not touched by this task.

## 4. Build and webview probe

`pnpm build; exit=0`. `pnpm probe:webview; exit=0`, final line: `PASS: no test-only crypto hook (sentinel, dependency metadata, imports) in the plugin, CLI or crypto surface`; earlier line `PASS: no Node built-in imports in the WebView bundle; src/kubo + src/core under the size limit`.

Coverage of the probe (tools/webview-import-probe.mjs):

- Plugin entry: yes. Baseline bundle of `src/main.ts` (606008 bytes), and the hook-isolation graph "plugin bundle (src/main.ts)" (203 inputs).
- src/sync: yes. `tools/webview-probe-entry.ts` references exclusions, hash, manifest, encrypted-manifest, publish, conflict-name, pull, pull-fetch, pull-plan, pull-record. Not every file of src/sync is in that entry (for example the newer encrypted pull modules), but they are covered through the `src/main.ts` baseline and the combined bundle (`src/main` + both probe entries). nodeBuiltinImports: [] and externalImports: [].
- src/crypto: yes. `tools/webview-probe-crypto-entry.ts` imports the whole `src/crypto` public surface (92574 bytes, 24999 gzip). Hook isolation checked sentinels src/crypto/testing/{argon2id-raw,generated-passphrase,unwrap-vck}.ts; importOffences: [].
- The probe also checks `dist/plugin/main.js` and `dist/cli/ipfs-sync.mjs` (ok: true, no violations).

Bundle sizes (dist, after this build):

| file | raw bytes | gzip -9 bytes |
|------|-----------|---------------|
| dist/plugin/main.js | 606141 | 155489 |
| dist/cli/ipfs-sync.mjs | 488087 | 128455 |

## 5. Constraint greps (definitions read from .kbd-orchestrator/constraints.md; each id has a `check:` and I ran exactly it)

- no-console-log-in-commits: PASS. `grep -r 'console\.log' src/ cli/ ...` printed nothing, exit=1 (no match).
- no-any-type: the literal check `grep -rn ': any\|as any\|<any>' src/ cli/` exits 0 with exactly two hits, both English words inside doc comments, not types: `src/sync/sequence-floor.ts:57` ("...: anything that is not exactly...") and `cli/init-command.ts:121` ("...: any entry at all..."). No `any` type usage. The literal check reports a match, so it is a false positive of the check's pattern; real type usage: none.
- no-hardcoded-secrets: PASS. grep printed nothing, exit=1.
- webview-safe-bundle: PASS. grep of src/ for Node built-in imports printed nothing, exit=1. The probe in item 4 also passed.
- no-python: PASS. `git ls-files '*.py'` empty. `grep -rIn 'python' package.json cli/ tools/ .github/` exits 2 only because `.github/` does not exist; rerun without `.github/` gave no matches, exit=1.
- never-sync-workspace-state: literal check FAIL (exit=1). It requires all three literals `".trash/"`, `".ipfs-sync/"`, `".obsidian/workspace.json"` in src/sync/exclusions.ts; only two are found now. Cause: this change (mvp-07a 1.3) replaced the individual `.obsidian/workspace*.json`, `graph.json`, `cache`, `plugins/` entries with the single entry `".obsidian/"`, which excludes the whole config folder (so workspace.json is still excluded in behavior). The constraint's check pattern is stale against the new exclusion list; the constraint intent holds, the literal check does not. Needs the constraint check updated (project config, not touched here) or an operator waiver. Severity of this constraint is `warning`.

## 6. pnpm audit

`pnpm audit; exit=1`, `1 vulnerabilities found / Severity: 1 moderate`: moment, GHSA-4p3w-j4w9-5jqw, path `.>obsidian>moment`, vulnerable >=2.29.2 <2.31.0. That is the accepted advisory and the only finding.

## 7. Integration suite

`pnpm exec vitest run tests/integration; exit=0`: Test Files 15 passed (15), Tests 85 passed (85), 15.86s.

## 8. Feature operation tools/feature-op-mvp-07a.mjs (no node contact)

- `node --check`: exit=0.
- `--dry-run`: exit=0, all lines PASS (toolbox bundle, hostile env stripped, foreign target refusals, policy refuses key/rm, pin/rm, files/mv, staging root; read allowlist; pull trace audit; cleanup target). It printed `NOTE dist/cli/ipfs-sync.mjs is newer than its sources` (informational).
- `--local-stub`: exit=0, `78/78 checks passed`, 0 FAIL. `dist/cli/ipfs-sync.mjs unchanged during the run: true` (sha256 20779701ccfd33b568946ef611012d5343ef04c7acbba278165405b025fdf8ad), i.e. distUnchangedDuringRun true. It ran against the freshly rebuilt dist. Result file: /var/folders/ln/0wnpd96j26z2qhvx9m6hwt2r0000gn/T/ipfs-sync-feature-ops/feature-op-mvp-07a.json. Its own "unverified even after a pass" list: in-app plugin pull and dialogs (until 07b operator run), `--resolve-fork` terminal confirmation, large-file pull and Range gateway behaviour on the shared node, plugin large-body transport, zeroization, authenticated kubo endpoint, other-platform path behavior.
- `--local-stub --tamper hash-mismatch`: exit=1 as expected, 77 PASS, exactly one FAIL: `first pull: every file's sha256 in B equals A's and the manifest's (1 mismatches) -- attachments/diagram.bin`.

## 9. checkDistBundles (tools/hook-isolation.mjs, also called by webview-import-probe.mjs and tests/unit/crypto-hook-isolation.test.ts, crypto-gate2b.test.ts)

Run directly: `{"ok":true,"checked":["dist/plugin/main.js","dist/cli/ipfs-sync.mjs"],"missing":[],"violations":[]}`, exit=0. Independent grep for `unwrap-vck`, `argon2id-raw`, `generated-passphrase`, `__test`: 0 hits in both bundles.

## 10. Tests added or changed in this change (git status --porcelain tests/, unstaged working tree)

- Modified, pre-existing: 45 files (`git diff --stat -- tests/`: 45 files changed, 1333 insertions, 189 deletions). 5 helpers: commit-scenario, fake-gateway, fake-kubo-http, fake-kubo, request-url-node. 40 unit tests: abandon-hint, cli-abandon, cli-init, cli-publish-lock, cli-publish-passphrase, cli-publish, cli-pull, encrypted-publish-kill, encrypted-publish-node, encrypted-publish-repair, encrypted-publish-review3, encrypted-publish-review3c, encrypted-publish, encrypted-transfer, exclusions, feature-op-mvp-06-helpers, obsidian-fs-semantics, obsidian-host-bridge, plugin-abandon, plugin-entry, plugin-lock-review5, plugin-publish-runner, plugin-publish-session, plugin-pull-entry, plugin-pull-runner, plugin-pull-settings-view-model, plugin-settings-model, plugin-settings-tab-pull, plugin-settings-tab, plugin-settings-v3, plugin-settings-view-model, publish-history-file, publish-journal-resume, publish-repair, pull-encrypted-root, pull-vault, read-back, root-state, sync-manifest-diff, sync-vault-keys (all `tests/unit/*.test.ts`).
- New (untracked): 55 entries = 10 helpers in tests/helpers (cli-pull-rig, cli-state-env, cli-two-device, encrypted-pull-rig, integration-devices, integration-plugin, memory-device-store, plugin-pull-encrypted-rig, pull-stage-rig, safety-scenarios), the directory tests/integration/ (15 test files, 85 tests), 2 vector files (tests/vectors/path-fold.json, path-policy.json), and 42 new tests/unit/*.test.ts files (blob-fetch, encrypted-pull-*, plugin-pull-*, publish-*, path-*, sequence-floor, three-way, and others).

## Unrun or unverified

- Nothing in the list was skipped. The shared node was deliberately not contacted, so any claim about it is unverified. The suite has 1 skipped test (pre-existing skip, not investigated).
