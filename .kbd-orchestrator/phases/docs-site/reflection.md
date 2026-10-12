# Reflection — docs-site

Date: 2026-10-12
Phase: docs-site (4/4 changes DONE, verified and archived; reconcile clean at reflect time)

## 1. Delta

1. **The QA gate, not the build, did the quality work.** The plan assumed the
   adversarial review was a confirmation pass over a correct delivery. It was
   not: the cumulative diff review ran four rounds — r1 BLOCK (8 findings),
   r2 BLOCK (4), r3 BLOCK (1), r4 PASS (0). Findings included a sanitizer
   coverage gap, stale content claims, a wrong README tree-hash statement, and
   a 4-character Basic-credentials pattern that bypassed detection inside
   quoted JSON. Evidence: `.kbd-orchestrator/phases/docs-site/review/cumulative*/findings.json`;
   fix commits `0148577`, `8858318`, `29ef916`.
2. **The lead wrote a wrong SHA into a dispatch instruction, and the
   remediation agent caught it.** The r2 remediation dispatch told the agent to
   record PR #2's merge commit as `1cd7663`; that SHA is PR #3's merge. PR #2's
   merge commit is `5ecc05a`, and its tag tree (`70dfb535…`) differs from the
   merge tree (`59084995…`) by post-tag docs commits. The README evidence now
   names both. Evidence: `0148577` remediation record; current `README.md`
   release-evidence section.
3. **The adversarial packet tool could not see the work it was asked to
   review.** `build-review-packet.sh` diff mode covers only uncommitted work or
   `git show HEAD`; this phase was already committed across ~10 commits. Each
   round required a documented `.diff` substitution (`git diff <base>..HEAD`,
   excluding `.kbd-orchestrator/**` and `site/package-lock.json`) plus a
   `.packet_note` recording the substitution. Evidence: `packet.json` files in
   each review round.
4. **docs-04's first deploy failed exactly where design.md predicted.** The
   Pages workflow ran before Pages was enabled on the repo (ordering
   dependency); one rerun after `gh api …/pages -X POST -f build_type=workflow`
   went green. This was anticipated, not a surprise — but it still cost a
   failed run. Evidence: `.github/workflows/docs-pages.yml` run history;
   docs-04 archive evidence.
5. **One evidence commit bypassed the PR flow.** `78b5bde` (docs-04 tasks
   4.2–4.4 evidence) was committed directly on main after PR #3 merged. It was
   a documented, deliberate choice (evidence-only, no code), but it is a
   divergence from the branch-per-change pattern the rest of the phase used.
6. **Publication receipts remain unproducible — unchanged, now with a recorded
   reason.** docs-04 task 4.4 evaluated the receipt condition honestly:
   `publication-receipt.mjs` requires per-artifact absolute download URLs and
   version strings on the first-party page; no site page carries them, so
   v0.2.0/v0.3.0/v0.4.0 receipts still cannot be produced. Recorded, not
   solved. Evidence:
   `openspec/changes/archive/2026-10-12-docs-04-pages-deploy-repo-link/evidence/publication-receipt-evaluation.md`.

## 2. Root Cause

- **Delta 1 & 2 — assertion from memory instead of from the tool.** Both the
  review findings and the wrong-SHA instruction came from the lead writing
  identifiers and claims that "seemed right" instead of reading `git log` /
  `gh` output at the moment of writing. The phase's own evidence discipline
  (every claim grepped against source in docs-01/docs-03) was applied to the
  site content but not to the lead's dispatch text.
- **Delta 3 — tool built for single-commit review.** The packet builder was
  authored against an uncommitted-diff workflow and never grew a range mode.
  Recurrence note: this is the same class of gap as the mvp phase's "tests
  passed but the bundle was broken" — a tool's happy path silently not covering
  the real artifact shape.
- **Delta 4 — platform ordering, not code.** GitHub Pages requires the Pages
  resource to exist before a `build_type=workflow` deploy can succeed. The
  design named it; the first run still hit it because enablement and first
  deploy were sequenced in the natural (wrong) order.
- **Delta 5 — boundary ambiguity after merge.** Once PR #3 merged, "the docs-04
  branch" no longer existed as a target, and the remaining work was evidence
  prose. No rule said where post-merge evidence commits go, so the lead chose
  main and documented it. The rule should exist, not be re-decided each time.
- **Delta 6 — a receipt condition written before the publication surface
  existed.** The first-party-page requirement predates the site. The site now
  exists but no change in this phase was scoped to add the asset-link page, so
  the condition stays unsatisfiable. This is scope, not failure — but it is now
  the single smallest change that unblocks three release receipts.

## 3. Corrective Actions

1. Dispatch text that names a SHA, URL, run ID, or PR number must be written
   from command output captured in the same session, never from memory. The
   lead applies this to itself; reviewers apply it to dispatch records.
2. `[GLOBAL]` Extend `build-review-packet.sh` with an explicit range mode
   (`--base <sha> --head <sha>`) so committed multi-commit phases are reviewable
   without a hand-substituted diff. Until then, every substituted packet must
   carry a `.packet_note` (done this phase; keep doing it).
3. `[GLOBAL]` For any GitHub Pages bootstrap, enable Pages via API *before*
   pushing the workflow, and record the enablement call in the evidence. Add
   this sequencing to the `build-branded-docusaurus` skill's deploy checklist.
4. Record the post-merge evidence-commit rule in the project rules: evidence
   prose for an already-merged change lands directly on main with a
   `docs:`/`chore:` prefix and a pointer to the change archive; code never
   does.
5. Schedule the publication-receipt asset-link page as a change in the next
   docs-touching phase (small: one site page + one README link + receipt run).
6. Decide the keyslot/state ignore-or-keep question (carried from mvp): the
   repo checkout is the vault's `.ipfs-sync/` state path, so
   `keyslots.*.json` / `state.*.json` / `.opencode/opencode-loop/` sit untracked
   at the repo root.

## 4. Goal Achievement

| Goal | Verdict | Reason |
| --- | --- | --- |
| Branded Docusaurus site (KnowMe branding, modeled on prometheus-skill-pack) fully explaining the plugin | MET | `site/` builds green; KnowMe tokens/logos ported; 10 content pages; build-output leak (`require.resolve` home path) found and fixed. |
| Setup guides for desktop and mobile | MET | `setup-desktop`, `setup-mobile` pages; mobile caveats verbatim from source, led by an explicit "unverified on mobile" statement (T3 honesty preserved). |
| GitHub Pages deployment via Actions + repository About link | MET | Site live at `https://prometheus-ags.github.io/obsidian-ipfs-sync/` (HTTP 200, corrected content spot-checked on the deployed page); `gh api repos/Prometheus-AGS/obsidian-ipfs-sync --jq .homepage` returns the Pages URL; workflow pinned to 5 action SHAs. |
| README.md verified 100% correct | MET | 165-claim inventory, 156 pass, 9 corrected (5 beyond the originally known stale lines). Evidence: docs-01 archive `evidence/claim-inventory.md`. |

Overall: 4/4 goals MET — 100%.

## 5. What Was Delivered

- `docs-01-readme-accuracy-pass` — (by: documentation-specialist, dispatched)
- `docs-02-docusaurus-scaffold-branding` — (by: documentation-specialist, dispatched; site/ toolchain isolated as npm under a pnpm root)
- `docs-03-site-content-guides` — (by: documentation-specialist, dispatched; CLI reference conformance-grepped: 12 commands / 41 flags / 16 env vars)
- `docs-04-pages-deploy-repo-link` — (by: release-deployment-lead, dispatched; sole publisher role respected)

All four: `kbd-apply verify` PASS, archived under
`openspec/changes/archive/2026-10-12-docs-*`, and synced into
`openspec/specs/` (the project's first four capability specs).

QA chain: adversarial diff review rounds r1–r4 (judge gpt-6.1-sol via
liter-llm) ending PASS with zero findings, then verify/archive per change.

## 6. Technical Debt Introduced

- **51 npm audit warnings** in `site/package-lock.json`, inherited verbatim from
  the donor's pinned dependency set. Deliberate: pin parity with the donor was
  a docs-02 requirement. Introduced by docs-02; resolution belongs to the donor
  alignment, not this repo alone.
- **Node-20 deprecation annotations** on the five pinned GitHub Actions SHAs in
  `.github/workflows/docs-pages.yml`. Pins stay until the donor's workflow
  aligns. Introduced by docs-04, deliberately.
- **Latent donor leak not fixed upstream**: the `require.resolve` home-path
  serialization exists in the prometheus-skill-pack donor site; fixed here,
  only reported for upstream. Surfaced, not silently copied.
- **Publication-receipt asset-link page** still missing (see Delta 6) — a debt
  the phase made cheaper to close, not one it created.
- Carried, untouched: cadence iteration 9 stuck; mobile sync never run (T3);
  old demo roots on the node; CLI lacks read cap/exclusion option; untracked
  keyslot/state files at repo root pending decision.

## 7. Architecture Integrity

- Team routing held: docs work went to documentation-specialist, publishing to
  release-deployment-lead (sole publisher), specs to product-manager; the lead
  orchestrated and integrated only. Dispatches recorded in `execution.md`.
- One writer per directory held: `site/` was written by one role at a time;
  repo-root manifests untouched (pnpm root vs npm site is intentional and
  documented in docs-02).
- Open standards: Docusaurus + GitHub Pages, no lock-in beyond the host
  already in use.
- AGENTS.md "Never Do"/constraint review: no violations found. The one
  borderline act (direct-to-main evidence commit) is named as Delta 5 with a
  corrective rule proposed, not hidden.
- The repo checkout still sits inside the vault's `.ipfs-sync/` state path —
  a pre-existing structural smell this phase did not worsen but must not keep
  ignoring (Corrective Action 6).

## 8. Cross-Tool Coordination Review

- Typed task transitions and progress projections were reliable: every task
  moved in-progress→complete through `prometheus kbd`, changes auto-completed
  on last task, and `kbd-apply reconcile docs-site` exits **clean at reflect
  time** — the mvp phase's 16-item backend↔ledger drift did not recur. The mvp
  lesson (reconcile before reflection; drive state through typed commands) was
  applied and worked.
- One tooling gap cost time: the review packet builder's missing range mode
  (Delta 3) made every review round partly manual.
- Handoff notes in the dispatch contracts worked well (the remediation agent
  had enough context to catch the lead's wrong SHA — the process working as
  designed). The unclear point was post-merge commit routing (Delta 5), now
  addressed by Corrective Action 4.

## 9. Lessons Learned

- The QA gate is where correctness came from this phase: three BLOCK rounds
  caught 13 findings in work that already "looked done". Budget the review
  rounds into the plan as expected iterations, not as failure.
- Any identifier (SHA, PR number, run ID, URL) written into a dispatch,
  doc, or reflection must be copied from fresh command output. The lead's
  wrong merge-SHA instruction is the counterexample on record.
- `[GLOBAL]` Review tooling that only diffs uncommitted work cannot review a
  committed phase. Packet builders need an explicit `base..head` range mode;
  until they have one, substitutions must be documented inside the packet.
- `[GLOBAL]` GitHub Pages bootstrap ordering: enable Pages (API,
  `build_type=workflow`) before the first workflow run, or the first deploy
  fails on a non-code precondition.
- Post-merge evidence prose needs a standing rule (direct to main, docs:/chore:
  prefix, archive pointer) so it is never re-decided ad hoc.
- "Unverified on mobile" leads the mobile page and the phase kept T3 honest
  through publication: user-facing docs must carry verification status, not
  aspiration. This pattern (caveat verbatim from source) is what let docs-03
  pass a hostile review.
- A receipt condition written before its surface exists stays silently
  unsatisfiable. docs-04's honest evaluation turned an invisible blocker into a
  one-page change request.
- `[USER]` The operator pre-authorizes outward steps (push, merge, Pages
  enablement, About link) at change boundaries when the demo record is green;
  that authorization is consumed by the acts it names and is not a standing
  grant.

## 10. Next Phase Seed

**Recommended Next Phase: `phase-mobile-and-hardening`** — the mvp reflection's
recommendation, still unstarted and now more valuable: mobile sync verification
(T3), Android/non-macOS/authenticated-endpoint testing, the CLI read-cap and
exclusion option, demo-root cleanup on the node, and the keyslot/state
ignore-or-keep decision. The docs site it ships with is now live and accurate,
so its "unverified on mobile" caveat becomes the phase's first target.

Candidate change to fold into that phase (or a small docs follow-up if it runs
first): the publication-receipt asset-link page (Corrective Action 5), which
unblocks v0.2.0/v0.3.0/v0.4.0 receipts with one site page and one README link.

## Artifact Quality Summary

No artifact-refiner runs occurred this phase (`.refiner/artifacts/` absent);
the QA gate was the adversarial diff review instead.

| Metric | Value |
| --- | --- |
| Review rounds | 4 |
| Findings (r1/r2/r3/r4) | 8 / 4 / 1 / 0 |
| Final verdict | PASS (zero findings) |
| Fix commits from review | 3 (`0148577`, `8858318`, `29ef916`) |

### Recurring constraint violations

- Assertions written from memory rather than command output (2 occurrences:
  README tree-hash wording; lead's wrong-SHA dispatch instruction) — see
  Corrective Action 1.
- Security-pattern detection bypasses in site tooling (2 rounds: short Basic
  credentials, then quoted-JSON form) — resolved by floorless Basic rules in
  `site/scripts/forbidden-patterns.mjs` with a 12-fixture self-test.

## Recalled Lessons

From `prior-context.md` (refreshed by `reflect:before`):

- **Applied** — "Default MVP verification demos to agent-run with recorded
  authorization": the docs-04 deploy, Pages enablement, and About-link acts ran
  agent-side under the operator's recorded pre-authorization; no ceremony
  inversion this phase.
- **Applied** — "External integrations require at least one real-service
  test": the live site was verified over HTTP (200 + content spot-check) and
  the repo About link via `gh api`, not inferred from CI green.
- **Applied** — mvp reconcile-drift lesson (from Previous reflection):
  reconcile run before reflection; clean exit 0.
- **Applied** — "Preserve production evidence in dated review folders": review
  rounds kept as separate immutable directories (`cumulative`, `-r2`, `-r3`,
  `-r4`); change evidence lives inside dated archive folders.
- **Recurred (contextual, not a new mistake)** — "Avoid repo checkouts inside
  `.ipfs-sync/`": keyslot/state artifacts still sit untracked at the repo root;
  decision deferred again (Corrective Action 6). Root cause named there.
- **Applied** — "CLI pull needs explicit `--accept-large`": the CLI reference
  page documents the 512 MiB ceiling and both acceptance flags, grepped
  against `cli/pull-encrypted-command.ts`.

## Codify as Skill?

- Extend `build-branded-docusaurus` with the Pages-enablement-first ordering
  and a post-merge evidence-commit rule (Corrective Actions 3–4). Candidate
  for `skill-update`; no new skill warranted.
