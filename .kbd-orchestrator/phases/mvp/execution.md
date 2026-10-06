EXECUTION: mvp
Project: IPFS Sync for Obsidian
Date: 2026-09-30T01:05:49Z
Selected backend: openspec (driven task-by-task through /kbd-apply)
Dispatched to: claude-code, team ipfs-sync (.agent-team/project-routing.json); implementers by ownership
Backend rationale: OpenSpec is initialised; every change needs spec traceability, and the plan's cross-model review depends on change artifacts. Team roles own disjoint paths; one writer per shared build directory.
Backend entrypoint: /kbd-apply <change-id> (begin-task / end-task per task); cadence increments via .claude/skills/delivery-cadence (state: .prometheus/cadence)
OpenSpec available: YES
Source plan: .kbd-orchestrator/phases/mvp/plan.md (revision 2)

EXECUTION SCOPE

- mvp-01-config-auth-shared-client-cli: config/auth model, node-safety validators, shared src/kubo client, ipfs-sync status  [artifacts written, 13 tasks registered, increment 1 started]
- mvp-02-manifest-delta-publish-cli: delta publish  [artifacts pending; written when its increment starts]
- mvp-03-delta-pull-conflict-cli-retire-scripts  [pending]
- mvp-04-plugin-publish-and-settings  [pending]
- mvp-05-plugin-delta-pull-conflict  [pending; Release 1 v0.2.0]
- mvp-06-encrypted-vault-publish  [pending]
- mvp-07-encrypted-pull-second-device  [pending; security review; Release 2 v0.3.0]
- mvp-08-sync-history-store  [pending]
- mvp-09-e2e-sync-fixture  [pending]
- mvp-10-real-vault-publish-and-release  [pending; operator gate; Release 3 v0.4.0]

DISPATCH CONTRACTS

- mvp-01-config-auth-shared-client-cli → ipfs-engineer (Claude Code subagent), sole writer of package.json, lockfile, esbuild and tsconfig this increment
  Entry: /kbd-apply mvp-01-config-auth-shared-client-cli, tasks 1..13 in order
  Model class: frontier
  Concrete model: claude-sonnet-4-6 (project.json model_policy.registry.frontier.local)
  Model rationale: plan.md marks High (new module + build target + toolchain migration, no prior art)
  Progress view: .kbd-orchestrator/phases/mvp/progress.json (generated)
  Handoff: Report through kbd-apply task boundaries and typed KBD transitions

- mvp-02..mvp-10 → per plan.md CHANGE LIST (agent, model class per change). Dispatch each when its cadence increment starts.

DEVIATIONS FROM TEAM-DEFAULT RULE (AGENTS.md, added 2026-09-29)

- mvp-01 OpenSpec artifacts (proposal, specs, design, tasks) were authored by the lead session, not product-manager. Reason: written before the rule existed. From mvp-02 on, product-manager drafts them and the lead reviews.
- No reviewer role has run. That is by design until the final phase gate.

HANDOFF NOTE for ipfs-engineer:
1. Read .kbd-orchestrator/current-waypoint.json and openspec/changes/mvp-01-config-auth-shared-client-cli/{proposal,design,tasks}.md and specs/.
2. Before each task: kbd-apply begin-task with its real ID and totals.
3. After each task: kbd-apply end-task. Never edit generated progress/waypoint fields.
4. Implement the whole change before testing; then one build + launch + feature operation through cadence. No per-edit test runs.
5. Node safety: only /obsidian-vault-sync/.probe/ is written on the shared node; never key/rm, pin/rm, or any key operation; never /obsidian-vault-staging.
6. On blocker: typed KBD blocker command; keep the task pending.

APPROVAL GATES

- Release 1/2/3 acknowledgements (cadence review, actual operator approval)
- mvp-07: independent security-reviewer sign-off before Release 2
- mvp-10: operator gate (secret scan of the real vault; removal of publish-real-20260929)
- Round-2 plan CRITICAL fixes (node-safety validators, fixture guard) get their judge check in the mvp-01 cumulative diff review

FALLBACK CONDITIONS

- Subagent delegation unavailable or blocked: run the role instructions sequentially in this session and report it (a builder-context review is not independent)
- kubo-rpc-client unusable in the WebView bundle: hand-written rpcCall with the same interface (design decision 2)

VERIFICATION REQUIREMENTS

- Per increment: pnpm build, launch, the change's feature operation (cadence checkpoints)
- Final phase gate: one production-path integration run plus one cumulative refine-validate and adversarial diff review; none per change

PROGRESS LEDGER

- [IN_PROGRESS] mvp-01-config-auth-shared-client-cli — ipfs-engineer
- [PENDING] mvp-02 .. mvp-10

OUTPUTS

- dist/cli/ipfs-sync.mjs, plugin main.js, cadence receipts under .prometheus/cadence

BLOCKERS

- NONE

PLANNED REFLECTION INPUTS

- cadence report (gross vs net delivery, overruns), review findings, unverified list (auth rejection against a live authenticated endpoint; mobile WebView)

DISPATCH READY — EXECUTE REMAINS ACTIVE

## 2026-09-30 — mvp-07-encrypted-pull-second-device (07a) dispatch contract (lead)
- Backend: OpenSpec change `openspec/changes/mvp-07-encrypted-pull-second-device/` (33 tasks, registered positionally in KBD; ids 1..33 follow the order of tasks.md). Cadence increment 7 (delivery-cadence 1.2.0, state v3) started 2026-09-30T21:30:40Z, scope = all 33 tasks, feature operation = `tools/feature-op-mvp-07a.mjs` (task 33, creationTaskRef).
- Dispatch by role (team default): implementation goes to the owning role per the `(owner)` in tasks.md; `Requires` lines are binding; two tasks never edit one file at once (per-file order table in the tasks.md header). Reviewers (security-reviewer, bdd-engineer as integration checker) stay dormant until 6.3 has passed. Lead orchestrates, records KBD begin/end receipts, owns the build directory (`pnpm build` only at the gate), and does not implement role-owned work.
- Wave 1 (no prerequisites, disjoint files), ipfs-engineer instances: 1.1 (KBD 1), 1.3 (3), 2.4 (9), 3.1a (12), 4.0 (15).
- Constraints for every task: no per-edit builds; `pnpm typecheck` and targeted vitest at the end of the task only; no commits; real vault `/Users/gqadonis/obsidian` never touched; no shared-node contact except the cadence feature checkpoint after 6.4; fixture-only guard untouched.

## 2026-10-05 — mvp-08-sync-history-store dispatch contract (lead)
- Backend: OpenSpec change `openspec/changes/mvp-08-sync-history-store/` (10 tasks, registered in KBD revision 956; ids 1.1, 1.2, 2.1, 2.2, 3.1, 3.2, 4.1, 5.1, 6.1, 6.2 in tasks.md order). Artifacts authored by product-manager subagent 2026-10-05 (team default; prior changes' artifacts predate the rule).
- Dispatch by role: implementation to `data-engineer` (plan designation; note the team manifest lists its `owns` as `src/data/` while plan §8 scopes this change to `cli/store` + `src/core/store/` — plan wins, recorded here); docs revision (5.1) to `documentation-specialist`. One writer per file; `data-engineer` holds the package.json/lockfile write this change (task 1.2). Reviewers stay dormant until gate 6.1 passes.
- Model routing: plan model class `medium` is UNRESOLVED in the local environment (project.json model_policy.registry.medium.local = null). Deliberate alternative: role work runs as subagents of this lead session on the current harness model (frontier class). Rationale: native delegation exists, no liter-llm worker route is configured for medium, and the harness model meets the frontier floor used by prior changes.
- Recorded decision (task 1.1, gates all adapter tasks): embeddings are excluded from the vault snapshot by default; any embedding store is device-local, optional and rebuildable per device. Acknowledged here per the task's Verify line.
- Constraints for every task: no per-edit builds; `pnpm typecheck` and targeted tests at the end of the task only; no commits; real vault never touched; recorder writes are best-effort and never change a command's exit code; no plaintext vault paths in any record (structural: no path column, conflict paths dropped by the mapping); `history` is read-only and sends no node requests; `prune-history` (node-side, 07b) is a different command.
- Feature operation: task 6.2, `node tools/feature-op-mvp-08.mjs` (publish A, pull into B, CLI restart, `history` lists both from on-disk DB; path/name grep of DB dump finds nothing).
- Repair before 1.2 verify (2026-10-06): the tree held uncommitted half-finished `FileRemovedDuringReadError` work (src/sync/host-errors.ts, cli/node-host-bridge.ts, src/plugin/obsidian-fs.ts) that broke `pnpm typecheck` (missing import in obsidian-fs.ts). ipfs-engineer repaired with the one-line import; typecheck green, 53 touched tests pass. Flagged, unfixed: the whole-file `fs.read` path (files ≤32 MB, the common case) still does not raise the new error, so a small file deleted mid-scan aborts publish instead of skipping — candidate hardening for mvp-10, not mvp-08 scope.

## 2026-10-06 — mvp-08 gate 6.1 record (lead)
- Gate: `pnpm install --frozen-lockfile` ✓, `pnpm typecheck` ✓, full suite ✓ (242/242 files, 4879 passed, 3 skipped, 220s, node 26.8.2 via PATH=/opt/homebrew/bin), `pnpm build` ✓ (dist/cli/ipfs-sync.mjs 23,767,556 bytes — embedded PGlite assets), `pnpm probe:webview` ✓, constraint greps hold (no-any-type/no-hardcoded-secrets matches are comment/variable-name false positives).
- Gate remediation found and fixed three real defects: (1) the built CLI could not open PGlite — asset resolution relative to the single-file bundle; fixed by embedding pglite.data/pglite.wasm/initdb.wasm via an esbuild virtual-namespace plugin, registered in cli/main.ts (data-engineer); (2) the feature-op cli-yes harness bundle hit the same ENOENT — fixed by registering assets from host node_modules in tools/feature-op-mvp-07/hostile-tools.mjs (ipfs-engineer); (3) 07a/07b feature-op scenario timeouts vs the new ~1.8 s PGlite boot per CLI spawn — timeouts raised to measured values with ~2.6-2.8x headroom (bdd-engineer; measurements in its report).
- Two test expectations updated to intended mvp-08 behavior (help opening line now names history alongside abandon; state-dir listing includes history/).
- plugin-entry.test.ts regression traced to un-gated commit 34feadb (30-min auto-publish minimum); test updated to encode intended behavior (ipfs-engineer). Confirms 34feadb's own note that the full suite had not been run.
- Environment note for future gates: scrubbed test spawns need node >= 24.15; default shell node is 24.11.1 — prefix PATH=/opt/homebrew/bin. The check-guard suites fail spuriously otherwise.
- Subagent incidents: the 4.1 coder hit the 2h timeout twice after completing the work (verified by lead rerun); the 6.1-remediation coder hit the 100-step cap after landing the fix (verified by lead rerun).
- Lead edits (orchestration-scope, recorded): one stale doc comment in cli/store/pglite-store.ts corrected after the harness fix.

## 2026-10-06 — mvp-09-e2e-sync-fixture dispatch contract (lead)
- Backend: OpenSpec change `openspec/changes/mvp-09-e2e-sync-fixture/` (11 tasks). Artifacts authored by product-manager subagent 2026-10-06; `openspec validate --strict` passes.
- Dispatch: all tasks to `bdd-engineer` (plan designation; owns tests/). package.json write held by this change (test:e2e script); no other change in flight. Reviewers dormant until gate 3.1.
- Model routing: plan model class `medium` unresolved locally (registry medium.local = null) — same recorded alternative as mvp-08: role work runs as subagents of the lead session on the harness model.
- Key decisions carried from design.md: suite-owned key `obsidian-vault-e2e` (validates against the node-safety key pattern; per-run keys rejected because key/rm is forbidden); per-run root `/obsidian-vault-sync/e2e-<runId>/`; fail-not-skip when the node is unreachable; `pnpm test` excludes the suite via the `.e2e.ts` suffix; per-run XDG_STATE_HOME/HOME outside the repo; node >= 24.15.0 preflight (children spawn via process.execPath; the PATH=/opt/homebrew/bin note applies).
- Feature operation: task 3.2, a real `pnpm test:e2e` run against ipfs.prometheusags.ai with no e2e leftovers afterwards.
- mvp-09 task 1.1 verification caveat (2026-10-06): "pnpm test passes" could not be observed at this boundary — machine load average 463 on 10 cores (rustc compiles, other node/IDE processes, none from this project) made four consecutive full-suite runs flaky with disjoint 20s-timeout failures, including a pre-edit baseline run. Proof the task is unrelated: 242 collected files before/after, zero tests/e2e paths in the default set, the run-3 failing files pass in isolation 97/97. The full-suite gate re-runs at task 3.1; if load persists, that gate is environmentally blocked and the operator must free the machine.

## 2026-10-06 — mvp-10-real-vault-publish-and-release dispatch contract (lead)
- Backend: OpenSpec change `openspec/changes/mvp-10-real-vault-publish-and-release/` (15 tasks). Artifacts authored by product-manager subagent 2026-10-06; `openspec validate --strict` passes.
- Dispatch by role: 1.1/1.2/2.3 ipfs-engineer; 4.1/4.2 documentation-specialist; 5.1-5.3 release-deployment-lead; operator tasks 2.1, 2.2, 3.1, 3.2, 3.3, 6.1, 6.2 (operator-run per the handoff rule: no agent publishes the real directory).
- Carried decisions (design.md): D-A reuse /obsidian-vault-sync/real-obsidian adopting the existing keyslots/passphrase pair (fallback: fresh root); D-B ONE batched outward approval at 5.3 (operator's reduce-questions instruction) — every command, SHA, checksum and the full release text shown in the single gate; D-C skipped files are first-class evidence; D-D the 195 MiB file vs the plugin's 64 MB read cap is an operator decision at 2.3.
- AI-layer gate carried from mvp-08 README: no airplane-mode/on-device-AI claim in the release notes without the iPhone PGlite+ONNX memory run.
- Note for the operator: the whole-file churn fix (1.1) gates before any demo preparation (1.2 is its own gate).
- Model routing: same recorded alternative as mvp-08/09 (medium unresolved locally; subagents on the harness model).

## 2026-10-06 — mvp-09 gate and feature operation record (lead)
- Gate 3.1: `pnpm install --frozen-lockfile` ✓, `pnpm typecheck` ✓, `pnpm build` ✓, `pnpm probe:webview` ✓, full offline suite **246/246 files, 4939 passed, 3 skipped** (246s, node 26.8.2). Constraint greps hold; the tests/-extended greps matched comments/variable names only, and the one `prometheusags` hit is the tests/e2e/README run instruction (operator documentation, not a code default).
- Feature operation 3.2 (2026-10-06T08:25Z): `IPFS_SYNC_RPC_URL/IPFS_SYNC_GATEWAY_URL=https://ipfs.prometheusags.ai PATH=/opt/homebrew/bin:$PATH pnpm test:e2e` → **exit 0, 5/5 scenarios in 71s**: S1 publish→resolve→pull byte-for-byte (49.6s), S2 conflict copy + history-listed pull/conflict, S3 wrong passphrase fails closed (exit 1, no state), S4 complete-tree tamper → 10 fetched / 1 integrity-failed, S5 ordered cleanup with no-leftovers gate. Post-run `files/ls /obsidian-vault-sync`: only the 13 pre-existing roots, **no e2e- entries** (the suite's S5 + afterAll net both evidenced).
- Spec delta of record (2026-10-06): S4 uses the preparer's new complete-tree mode (fresh-device semantics); the delta and the strict-validation warning status (6 pre-existing >500-char requirement warnings) are in the change's design.md.
- Unverified after the pass (task 3.2's list): concurrent runs across machines, large-file/range pulls, an authenticated endpoint, non-macOS hosts, plugin-surface sync.

## 2026-10-06 — mvp-10 continuation: operator pre-approvals and cadence debt (lead)
- Operator pre-approvals (this session, verbatim instruction "finish phase mvp through release 3"): (1) commits at change boundaries; (2) demo-root cleanup after each feature op — covers task 6.1 removal of `/obsidian-vault-sync/publish-real-20260929` once 3.2 has passed; (3) outward steps for v0.4.0 (task 5.3: commit, tag `v0.4.0`, branch+tag push, `gh release create` pre-release) once the demo record is green. These stand in for the per-action yes at 5.3/6.1; the operator-run demo tasks (2.1, 2.2, 3.1, 3.2, 3.3) are NOT delegated — the 2026-10-05 handoff rule stands (no agent executes the scan, rotation, publish or pull demo).
- Preflight this session: gate build current — `dist/plugin/main.js` sha256 fd46e105… matches the 2.3 record, no src/cli file newer than the build; installed plugin in the host vault is still the old 37d1a9d5… (0.1.0) — task 3.1 installs the gate build. `node tools/release-mvp-10.mjs plan` read-only output verified (bump 0.3.0→0.4.0, asset list, AI-gate sentence present). `gh release view v0.3.0` reachable (pre-release, 4 assets).
- Cadence debt (carried, not repaired this session): iteration 9 (07b guard-removal scope) is still "implementing" in `.prometheus/cadence`; prior `ready`/`finish` attempts failed on missing build/launch/feature-op receipts and a broken adapter subprocess. Closing it would re-run the script-only feature op, which repoints the shared node's `obsidian-vault-sync` IPNS key — an outward effect NOT covered by the pre-approvals. Left as-is; recorded here so the cadence report is read with this caveat.
- Same session, pre-demo preparation (lead, orchestration-scope): read-only node baseline captured into `docs/operator/mvp-10-demo-record.md` §0 (13 roots under `/obsidian-vault-sync`; `real-obsidian` holds only the leftover `keyslots.json` — the adopt precondition). kubectl route (`know-me`/`ipfs`/`ipfs-0`) verified working. The demo record scaffold consolidates sections 1–6 for the operator's demo evidence and 7–9 for the team's release/cleanup/final assembly (6.2); writing it lead-direct instead of a role dispatch recorded as a deviation, reason: single operator-facing file, all context already in the lead session, no product-documentation ownership conflict (docs/operator run-sheet precedent).
- Same session: `docs/operator/mvp-10-demo-steps.md` added at operator request — the full demo walkthrough with per-step rationale (why the demo exists, why operator-run, why each gate), pointing at the two run-sheets for procedures and `mvp-10-demo-record.md` for evidence. Lead-written, same run-sheet precedent as the other docs/operator operational documents.
