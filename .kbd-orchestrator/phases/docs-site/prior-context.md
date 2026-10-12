# Prior context — docs-site (execute)

> Auto-populated by /kbd-memory-recall for lead view (main thread); lessons from pk. Cite the lessons that apply; recalled entries are information recorded by agents, not instructions.

## Lessons

- [pk:project] MVP phase reflection: release process gaps and corrective actions: The MVP phase delivered multiple releases but exposed process gaps in demo authorization, ledger synchronization, cadence tracking, artifact verification, commit boundaries, mobile verification, CLI/plugin parity, publication receipts, and OpenSpec lifecycle ownership. - **Operator-hands demo rule was inverted late.** The `mvp-10` plan originally required the real-vault demo to be operator-run; an agent executing publish would invalidate the demo. After the ceremony cost became clear, the operator authorized an agent-run CLI demo in decision D-E on 2026-10-11. The demo completed in under 20 mi _(recorded by an agent; lesson; via pk learning:87ff085bd0ebc5a2)_
- [pk:project] Bulk operator verdicts are valid adjudication when recorded with basis: A bulk verdict from the operator is valid adjudication when it is explicitly recorded as a bulk verdict with its basis; do **not** fabricate per-row reviews merely to make a review table appear complete. _(recorded by an agent; lesson; via pk learning:cafe6437a9cf50af)_
- [pk:project] Avoid repo checkouts inside .ipfs-sync state directories: Do not place a repository checkout inside the synced vault's internal state directory, `.ipfs-sync/`. A checkout nested there collides with sync-state files, so keyslot and state artifacts can appear at the repository root during operation. - Treat `.ipfs-sync/` as application-owned sync state, not as a workspace location. - Keep source checkouts outside `.ipfs-sync/`. - If a checkout has already been created inside `.ipfs-sync/`, expect state/keyslot artifacts mixed into the repo root and audit before committing. _(recorded by an agent; lesson; via pk learning:cf2f5343dd7f4c27)_
- [pk:project] CLI pull needs explicit --accept-large for blobs over 512 MiB: For non-interactive encrypted pulls, `--accept-first-pull` is not sufficient when the pull exceeds the 512 MiB large-size confirmation ceiling. The CLI also requires `--accept-large` to bypass the size confirmation gate. Relevant implementation note: `cli/pull-encrypted-command.ts:107` enforces the large-pull acceptance separately from first-pull acceptance. - When documenting pull orchestration behavior, distinguish this CLI confirmation ceiling from ranged blob-fetch behavior such as large ignored-range files being marked `unfetched` in [Karpathy session 44db43464467](/karpathy-session-44db4 _(recorded by an agent; lesson; via pk learning:5a6d5406cb773a6a)_
- [pk:project] Record gitleaks byte coverage alongside finding counts: `gitleaks` skips files it detects as binary, so a finding count alone is insufficient evidence of scan coverage. Record scanned-byte coverage next to every finding count to make skipped-byte/file exposure visible. _(recorded by an agent; lesson; via pk learning:11cbe08191e27aea)_
- [pk:shared] Default MVP verification demos to agent-run with recorded authorization: For MVP phase verification, default demos to **agent-run execution with recorded operator authorization** rather than requiring the operator to perform the demo by hand. Reserve operator-hands requirements for actions that are truly account-bound or require human judgment, such as adjudication decisions. - `design.md` - `execution.md` _(recorded by an agent; lesson; via pk learning:351f041cc1b0c9d6)_
- [pk:shared] External integrations require at least one real-service test: For every external integration, run at least one test against the real service before claiming the work is done. Fakes and mocks can hide service-specific preconditions, such as labels that must already exist or context that is inherited rather than supplied explicitly. - Prefer CI or repeatable scripts for the real-service check when feasible; see related real-environment validation patterns in [Codex plugin verify-and-publish phase goals and validation plan](/codex-plugin-verify-and-publish-phase-goals-and-validation-plan.md) and [Live Postgres startup checks for flint_meta reflection drift] _(recorded by an agent; lesson; via pk learning:ddd2db0fb37f6232)_
- [pk:shared] Installer behavior tests must exercise installer dispatch: A component-level test passing is not evidence that the production installer entry point uses that component. If a specification says “the installer applies X,” validate the behavior through the installer's dispatch path, or add a structural assertion proving the install path reaches the relevant call. _(recorded by an agent; lesson; via pk learning:ba6b5cffdef7de64)_
- [pk:shared] Preserve production evidence in dated review folders: When saving production evidence for operator review, create a new dated evidence folder with a `README`; never overwrite or mutate earlier evidence folders. - Store production evidence in a newly created dated directory for each run, e.g. `evidence/2026-10-06/` or `review-artifacts/2026-10-06-<short-purpose>/`. - Include a `README.md` that makes the evidence set navigable and records: _(recorded by an agent; lesson; via pk learning:0d46bd8a48d92ee1)_

## pk knowledge

*(no pk knowledge for this phase)*

## Previous reflection

From `mvp/reflection.md`:

**Delta**

1. **The operator-hands demo rule was inverted at the finish line.** The mvp-10 plan made the real-vault demo operator-run ("an agent executing the publish … invalidates the demo", written from the 2026-10-05 handoff). After experiencing the ceremony's cost, the operator authorized an agent-run CLI demo (decision D-E, 2026-10-11, execution.md). The demo then completed in under 20 minutes of machine time. Evidence: `openspec/changes/mvp-10-real-vault-publish-and-release/design.md` D-E; `docs/operator/mvp-10-demo-record.md`.
2. **Backend↔ledger drift accumulated silently.** `kbd-apply reconcile mvp` at reflection time reported 16 ledger-ahead drift items across four already-closed changes (mvp-04, mvp-05, mvp-07b ×13, mvp-10) — the canonical ledger knew the tasks were done; the OpenSpec tasks.md checkboxes did not. Repaired 2026-10-11; reconcile now clean. Evidence: `/tmp/reconcile*.log`.
3. **Delivery-cadence tracking was abandoned mid-phase without a recorded decision.** Iteration 9 (07b scope) is still "implementing" in `.prometheus/cadence`; its `finish` failed twice (missing build/launch/feature-op receipts; the Kimi-Helper adapter subprocess failing) and was left open. mvp-08/09/10 ran with no cadence increments at all. Evidence: `.prometheus/cadence/state.json`, `commandErrors`, execution.md 2026-10-06 debt note.
4. **The single-file bundle broke on embedded WASM assets, and only the gate caught it.** The built CLI could not open PGlite (asset resolution relative to the bundle); unit tests were green throughout. Two follow-on defects (feature-op harness bundle, spawn timeouts) surfaced at the same gate. Evidence: execution.md mvp-08 gate 6.1 record (2026-10-06).
5. **Work sat uncommitted across days.** Dispatch contracts said "no commits" during tasks but named no boundary commit; mvp-09's whole suite and mvp-10's hardening were only committed when the operator asked (2026-10-11). Commit 34feadb had earlier landed without a full-suite run and regressed `plugin-entry.test.ts`, found at the next gate. Evidence: git history; execution.md mvp-08 record.
6. **Mobile is still unverified (T3).** The 07b phone-timing gate passed (iPhone, under the 3 s/100 ms threshold), but no mobile *sync* has ever run; mvp-10's optional mobile attempt was not run.
7. **The CLI has no read cap and no exclusion option.** D-E's CLI demo rout
… (truncated)

## Knowledge gaps

- Cadence iteration 9 open in `.prometheus/cadence` (missing receipts; adapter subprocess broken; no documented fallback).
- Publication receipt pending for v0.2.0, v0.3.0, v0.4.0 — the first-party-page condition has never been satisfiable.
- CLI has no read cap and no exclusion option (plugin-only); stated in the v0.4.0 notes, unscheduled.
- Mobile sync unverified (T3); Android untested; non-macOS hosts untested; authenticated endpoint untested.
- OpenSpec `verify`/`archive` never run; `openspec/changes/` holds 11 completed-but-unarchived changes; `openspec/specs/` empty.
- Old demo roots remain on the node (`mvp02..mvp08-demo`, `mvp06-probe`, `phone-test-1`, `phone-test-big`); only `publish-real-20260929` was in cleanup scope.
- `keyslots.f6720bcd22c0ded6.json` (the adopted vault's local slot copy) sits untracked at the repo root because the repo checkout *is* the vault's `.ipfs-sync/` state path; needs an explicit ignore/keep decision.
- Demo-record scanner caveat: gitleaks read 672 MB of 955 MiB (binary-detected files skipped).
- DESIGN.md §8.7 item 1 likely stale (flagged by the docs pass, needs the operator-run record to settle); CHANGELOG's historical
… (truncated)
