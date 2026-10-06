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
