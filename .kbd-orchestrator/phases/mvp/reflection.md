# Phase Reflection: mvp

**Project:** IPFS Sync for Obsidian
**Date:** 2026-10-11
**Phase completion:** 100% (16/16 changes terminal: 11 DONE, 5 SKIPPED as superseded duplicates)
**Changes completed:** 11 / 16 (5 skipped by design — renamed duplicates superseded by their successors)

## Delta

1. **The operator-hands demo rule was inverted at the finish line.** The mvp-10 plan made the real-vault demo operator-run ("an agent executing the publish … invalidates the demo", written from the 2026-10-05 handoff). After experiencing the ceremony's cost, the operator authorized an agent-run CLI demo (decision D-E, 2026-10-11, execution.md). The demo then completed in under 20 minutes of machine time. Evidence: `openspec/changes/mvp-10-real-vault-publish-and-release/design.md` D-E; `docs/operator/mvp-10-demo-record.md`.
2. **Backend↔ledger drift accumulated silently.** `kbd-apply reconcile mvp` at reflection time reported 16 ledger-ahead drift items across four already-closed changes (mvp-04, mvp-05, mvp-07b ×13, mvp-10) — the canonical ledger knew the tasks were done; the OpenSpec tasks.md checkboxes did not. Repaired 2026-10-11; reconcile now clean. Evidence: `/tmp/reconcile*.log`.
3. **Delivery-cadence tracking was abandoned mid-phase without a recorded decision.** Iteration 9 (07b scope) is still "implementing" in `.prometheus/cadence`; its `finish` failed twice (missing build/launch/feature-op receipts; the Kimi-Helper adapter subprocess failing) and was left open. mvp-08/09/10 ran with no cadence increments at all. Evidence: `.prometheus/cadence/state.json`, `commandErrors`, execution.md 2026-10-06 debt note.
4. **The single-file bundle broke on embedded WASM assets, and only the gate caught it.** The built CLI could not open PGlite (asset resolution relative to the bundle); unit tests were green throughout. Two follow-on defects (feature-op harness bundle, spawn timeouts) surfaced at the same gate. Evidence: execution.md mvp-08 gate 6.1 record (2026-10-06).
5. **Work sat uncommitted across days.** Dispatch contracts said "no commits" during tasks but named no boundary commit; mvp-09's whole suite and mvp-10's hardening were only committed when the operator asked (2026-10-11). Commit 34feadb had earlier landed without a full-suite run and regressed `plugin-entry.test.ts`, found at the next gate. Evidence: git history; execution.md mvp-08 record.
6. **Mobile is still unverified (T3).** The 07b phone-timing gate passed (iPhone, under the 3 s/100 ms threshold), but no mobile *sync* has ever run; mvp-10's optional mobile attempt was not run.
7. **The CLI has no read cap and no exclusion option.** D-E's CLI demo route could not implement "excluded" adjudication verdicts; the 195.4 MiB file published uncapped. Carried as a stated limitation in the v0.4.0 notes, not fixed.
8. **Publication receipts were never produced** — v0.2.0, v0.3.0, v0.4.0 all record "pending — no first-party page with absolute asset URLs exists". Three releases in, the condition has never been met.
9. **OpenSpec lifecycle steps were skipped phase-wide.** No change went through `kbd-apply verify` / `archive`; `openspec/changes/archive/` is empty and `openspec/specs/` holds no capability specs. Completion evidence lives in execution.md and the KBD ledger instead.

## Root Cause

1. The operator-hands rule was written from one permission-denial moment and had no re-examination trigger. Once mvp-09's unattended e2e suite proved the same engine path against the same node, human hands added ceremony, not evidence — but the plan still enforced it until the operator paid the cost personally. Recalled lesson recurred in stronger form: *"Ask once at phase boundary for operator-only actions"* (pk) — first batching (D-B), then pre-approval, then full delegation (D-E).
2. Reconcile was never scheduled. Task completion was recorded in the ledger by `prometheus kbd task transition`, and checkbox ticking in tasks.md was manual and forgotten. No hook fired reconcile at a change boundary.
3. Cadence `finish` depends on receipts produced through an adapter subprocess with a brittle app-path; when it failed there was no documented fallback (`adoptedReceipts` exists in state but no procedure), so the failure was parked. Cadence then silently stopped being used — no decision record.
4. Recalled lesson recurred: *"Installer behavior tests must exercise installer dispatch"* — component-level tests pass while the production entry point fails. Asset embedding only broke in the built artifact; nothing in the suite built and launched the bundle until the phase gate did.
5. The one-writer-per-build discipline was enforced, but its counterpart (a named boundary commit) was not. "No commits during tasks" + no scheduled commit = uncommitted accumulation.
6. Mobile verification needs a physical-device pipeline (BRAT pre-release → phone install). It exists (built for 07b) but was optional in mvp-10 and optional items defer by default.
7. CLI/plugin parity was never scoped into any change; the plugin grew settings (read cap, exclusions) that the CLI route lacks. D-E exposed the asymmetry only when an adjudication verdict couldn't be implemented.
8. The receipt rule assumed a first-party page that no change ever created; the condition outlived three releases without anyone owning the page.
9. The verify/archive steps have no hook and no owner in the dispatch contracts; the team treated the KBD ledger + execution.md as the record of truth and OpenSpec as planning-only.

## Corrective Actions

1. [USER] Default verification demos to agent-run with a recorded operator authorization; reserve operator-hands requirements for account-bound actions and judgment calls (adjudication). Record the authorization in the change's design.md and execution.md, as D-E did.
2. [GLOBAL] Run the backend↔ledger reconcile (`kbd-apply reconcile <phase>`) at every change boundary, not at reflection; repair drift immediately — ledger-ahead means stale checkboxes, backend-ahead means lost credit.
3. Document a receipt-adoption fallback for delivery-cadence `finish` (adopt existing external evidence instead of re-running outward checkpoints), or delete the cadence binding for phases that don't use it. Record the adapter-subprocess fragility as a known failure mode.
4. [GLOBAL] Every boundary gate must build *and launch* the packaged artifact through its real entry point; source-level suites cannot see bundle/asset-resolution failures.
5. Name the boundary commit in every dispatch contract ("no commits during tasks; one commit at the gate"), so "no commits" cannot accumulate across days.
6. Next phase must either schedule the phone sync run (the BRAT pipeline from 07b exists) or declare mobile sync out of scope — stop carrying T3 as silent debt.
7. Scope CLI/plugin parity (read cap, exclusion option) as a change, or record a deliberate divergence decision in DESIGN.md.
8. Either create the first-party release page that makes publication receipts possible or strike the receipt condition from release definitions.
9. Decide the OpenSpec lifecycle: run `verify`/`archive` for the 11 delivered changes and generate `openspec/specs/`, or record that OpenSpec is planning-only in this project and stop pretending archival is pending.

## Recalled Lessons

- Recurred: *"Ask once at phase boundary for operator-only actions"* — the question-count pressure grew through the phase (per-action yes → batched D-B → pre-approval → D-E delegation). The lesson was right; the phase kept having to re-learn how much ceremony the operator would tolerate.
- Recurred: *"Installer behavior tests must exercise installer dispatch"* — the PGlite-asset bundle failure at mvp-08's gate is the same pattern: component green, production entry point broken.
- Applied: *"Put pinned runtime first on PATH before running gates"* — every gate from mvp-08 onward ran with `PATH=/opt/homebrew/bin` after the node-24.11 shim caused spurious failures.
- Applied: *"External integrations require at least one real-service test"* — every change ended in a feature operation against the real node; mvp-09 added a standing e2e suite.
- Applied: *"Include plan amendments in reviewer and judge packets"* — D-E was written into design.md/tasks.md/specs before the demo record cited it.
- Not applicable this phase: worktree/harness-config lesson, reentrant-lock lesson.

## Goals

| Goal | Status | Notes |
|---|---|---|
| 1. Replace shell scripts with cross-platform Node 24+ CLI | MET | CLI delivered and is the only documented path; scripts retired in mvp-03; v0.4.0 ships the CLI tarball; constraint greps (`no-python`, `no-default-node`) held at every gate |
| 2. Delta sync: manifest + persistent MFS tree, mobile-safe publish/delta pull | MET | Manifest v2 + persistent `current/` tree delivered (mvp-02/03); phone timing measured under the 3 s/100 ms bound (07b task 7.2). Caveat: mobile *sync* never ran (T3) — "mobile-safe" is evidenced by timing/memory bounds, not a phone sync |
| 3. One shared kubo RPC client consumed by plugin and CLI | MET | Shared client in src/core consumed by both hosts since mvp-01/04; the real-vault demo exercised the CLI consumer |
| 4. Plugin stays WebView-safe; conflict policy unchanged | MET | `pnpm probe:webview` green at every boundary gate; remote-wins-with-dated-copy policy preserved and e2e-tested (mvp-09 S2) |
| 5. Framework seams: event bus, host-bridge interface, store adapters | MET | HostBridge implemented by CLI and plugin hosts; store adapters behind interfaces (memory, map-event, PGlite — mvp-08) |
| 6. E2E fixture test green; real 1 GB vault published via the new pipeline | MET | mvp-09 e2e 5/5 green against the production node (2026-10-06); mvp-10 published the real vault (4,825 files / 1,001,531,092 bytes) and reproduced it with 0 mismatches (2026-10-11, demo record) |
| 7. Client-side encryption before the node; passphrase unlock on second device; tamper fails closed | MET | Encryption unconditional since mvp-06; second-device pull (07a) and wrong-passphrase/tamper refusal (mvp-09 S3/S4) green; the real vault published encrypted with the adopted key slot |

## Delivered Changes

- `mvp-01-config-auth-shared-client-cli` — config/auth model, shared kubo client, `status` (by: Kimi Code lead + subagents)
- `mvp-02-manifest-delta-publish-cli` — manifest delta publish (by: same)
- `mvp-03-delta-pull-conflict-cli-retire-scripts` — delta pull, conflict policy, script retirement (by: same)
- `mvp-04-plugin-publish-and-settings` — plugin publish via shared core + settings (by: same)
- `mvp-05-plugin-delta-pull-conflict` — plugin delta pull; Release 1 v0.2.0 (by: same)
- `mvp-06-encrypted-vault-publish` — client-side encrypted publish (by: same)
- `mvp-07-encrypted-pull-second-device` — encrypted pull on a second vault; Release 2 v0.3.0 (by: same)
- `mvp-07b-keys-history-guard-release-2` — keys, history pruning, guard removal, phone timing (by: same)
- `mvp-08-sync-history-store` — PGlite sync history store + `history` CLI (by: same)
- `mvp-09-e2e-sync-fixture` — e2e encrypted sync suite against the production node (by: same)
- `mvp-10-real-vault-publish-and-release` — churn hardening, real-vault round trip, Release 3 v0.4.0 (by: same)

(Skipped as superseded duplicates: mvp-01-node-cli-and-shared-kubo-client, mvp-04-plugin-publish-via-shared-core, mvp-06-sync-history-store, mvp-07-e2e-sync-fixture, mvp-08-real-vault-publish-and-release.)

## Technical Debt

- Cadence iteration 9 open in `.prometheus/cadence` (missing receipts; adapter subprocess broken; no documented fallback).
- Publication receipt pending for v0.2.0, v0.3.0, v0.4.0 — the first-party-page condition has never been satisfiable.
- CLI has no read cap and no exclusion option (plugin-only); stated in the v0.4.0 notes, unscheduled.
- Mobile sync unverified (T3); Android untested; non-macOS hosts untested; authenticated endpoint untested.
- OpenSpec `verify`/`archive` never run; `openspec/changes/` holds 11 completed-but-unarchived changes; `openspec/specs/` empty.
- Old demo roots remain on the node (`mvp02..mvp08-demo`, `mvp06-probe`, `phone-test-1`, `phone-test-big`); only `publish-real-20260929` was in cleanup scope.
- `keyslots.f6720bcd22c0ded6.json` (the adopted vault's local slot copy) sits untracked at the repo root because the repo checkout *is* the vault's `.ipfs-sync/` state path; needs an explicit ignore/keep decision.
- Demo-record scanner caveat: gitleaks read 672 MB of 955 MiB (binary-detected files skipped).
- DESIGN.md §8.7 item 1 likely stale (flagged by the docs pass, needs the operator-run record to settle); CHANGELOG's historical Unreleased section retains a written-at-the-time "v0.3.0 is not cut" narrative line.

## Architecture Integrity

- AGENTS.md "Never Do" violations: none observed in shipped code. Process deviations, all recorded in execution.md: lead wrote operator-facing run-sheets directly (docs/operator precedent); role work ran as subagents on the harness model because plan model class `medium` is unresolved locally; the docs/operator files were committed on the release branch rather than a docs branch.
- Constraint violations: none — all six constraint greps held at every boundary gate; `no-python`, `no-default-node`, WebView-safe bundle, no hardcoded secrets.
- One writer per build directory held; `dist/` writes only at gates and the release record.

## Cross-Tool Coordination Notes

- Progress tracking: GAPS FOUND — 16 ledger-ahead reconcile drifts at reflection (repaired); cadence abandoned silently after 07b. The KBD ledger itself was reliable throughout; the backends around it were not kept in sync.
- Handoff quality: CLEAR — execution.md dispatch contracts and the docs/operator run-sheets carried every change; the one handoff that failed (2026-10-05 operator-hands rule) failed by being too strong, not unclear, and was amended in the open (D-E).

## Lessons Learned

- A bulk verdict from the operator is valid adjudication when it is recorded as a bulk verdict with its basis; never fabricate per-row reviews to make a table look complete.
- [USER] This operator prefers zero-question execution once evidence gates are green: collect pre-approvals (commits, cleanup, outward steps) at dispatch time and record them verbatim in execution.md.
- [GLOBAL] A plan rule written in reaction to a single permission denial ("an agent must never run X") needs a re-examination trigger; otherwise it outlives the evidence that made it redundant and becomes ceremony.
- [GLOBAL] Gate on the packaged artifact through its real entry point, not only the source suite — bundle asset resolution (WASM/data files) fails only in the built output.
- [GLOBAL] When a scan returns thousands of findings, group by rule and by file before asking a human to adjudicate; 64% of this vault's 686 publishable findings sat in two files, and the human decision took one sentence.
- The CLI's non-interactive pull needs `--accept-large` above the 512 MiB confirmation ceiling *in addition to* `--accept-first-pull`; the first-pull flag does not cover the size ceiling (`cli/pull-encrypted-command.ts:107`).
- [GLOBAL] Run the ledger↔backend reconcile at every change boundary; drift compounds silently and reflection-time repair costs an hour of archaeology.
- A repo checkout placed inside the synced vault's own state directory (`.ipfs-sync/`) collides with sync-state files — expect keyslot/state artifacts at the repo root and decide ignore rules deliberately.
- gitleaks skips binary-detected files; always record scanned-bytes coverage next to a finding count.
- [GLOBAL] A feature operation that prints its full file list doubles as the authoritative published-set manifest for later comparison — the mvp-10 sha256 proof was built from the publish log, not a re-scan.

## Next Phase Seed

`phase-mobile-and-hardening` — (1) retire or explicitly accept T3: run a real mobile sync through the 07b BRAT pipeline, or declare mobile out of scope; (2) close the honesty debts: publication-receipt infrastructure (a first-party page) or strike the condition, OpenSpec verify/archive backlog decision, cadence repair or removal; (3) CLI/plugin parity decision (read cap, exclusion option) and the remaining unverified surfaces (Android, non-macOS, authenticated endpoint).

## Codify as Skill?

- The release-demo runbook pattern recurred in every change this phase (feature-op script → demo record → release tool → receipt). A `release-demo-runbook` skill (scan/adjudicate → publish → pull → compare → record → release) would formalize what mvp-10 did by hand. No pending pk candidate matches it (checked 2026-10-11: `pk candidates list --kind skill` and `--kind promotion` both empty).

## Context for Next Phase

Use this file as prior context for the next `/kbd-assess` invocation.
