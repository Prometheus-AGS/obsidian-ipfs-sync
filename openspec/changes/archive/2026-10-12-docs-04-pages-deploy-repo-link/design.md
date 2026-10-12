## Context

The repo has no `.github/` at all (assessment, 2026-10-12). The donor at `~/Projects/prometheus/prometheus-skill-pack` ships a deployment-only `docs-pages.yml` with pinned action SHAs, a `paths: site/**` trigger, a concurrency group, and a policy comment that tests do not run in CI (local gates only) — allowed under the skill-pack's local-only rule, and this repo's AGENTS.md does not forbid it. Pages must be enabled in repo settings before the first deploy. The publication receipts for v0.2.0/v0.3.0/v0.4.0 are pending because the first-party-page condition has never been satisfiable; a deployed first-party docs site could satisfy it — evaluation only, no fabricated receipts.

## Recorded decision: the About link cannot be set by the GitHub Action

**Decision (recorded 2026-10-12):** the repository About link is set by a **one-time operator-authorized `gh repo edit --homepage https://prometheus-ags.github.io/obsidian-ipfs-sync/`**, run after the first green deploy. The user's literal ask — "the github action sets up the About link" — is **not achievable as stated** and this decision says so in the open.

**Mechanism of the constraint:** GitHub Actions' `GITHUB_TOKEN` cannot edit repository metadata. The Update-a-repository REST endpoint (`PATCH /repos/{owner}/{repo}`, which owns the `homepage` field) requires Administration write permission, which the workflow token does not carry and cannot be granted through `permissions:` in the workflow file.

**Routes considered:**

1. **One-time operator-authorized `gh repo edit --homepage <pages-url>` (recommended, chosen).** Simplest; the value is set once and never changes; no secret is created; the authorization is explicit and recorded in the task evidence. Verification is a readback: `gh api repos/Prometheus-AGS/obsidian-ipfs-sync --jq .homepage`.
2. **PAT-secret-backed workflow step (fallback, rejected unless the operator rejects route 1).** A personal access token stored as a repo secret could call the endpoint from CI. Rejected as the default because it adds ongoing secret maintenance (rotation, expiry, scope review) to automate a set-once value — permanent cost for a one-time action. If the operator insists on in-workflow automation, task 4.3 changes shape and gains a secret-management prerequisite (phase plan, "Scope cuts and trade-offs").

**Authorization boundary:** task 4.3 executes the chosen route only after operator authorization. If the operator declines all routes, the task records the refusal as its outcome; it does not fabricate a set link.

## Decisions

1. **Deployment-only workflow.** `docs-pages.yml` builds and deploys; it runs no tests. Rationale: the donor's own policy (tests are local gates), and the docs-02/docs-03 gates (sanitizer, `onBrokenLinks: throw`, `verify.mjs`, production build) already ran locally before merge. Adding a redundant CI test tier would double build time for no new signal.
2. **Pinned SHAs.** Every action is pinned by full commit SHA, copied from the donor: checkout v4 `34e114876b0b11c390a56381ad16ebd13914f8d5`, configure-pages v5 `983d7736d9b0ae728b81ab479565c72886d7745b`, setup-node v4 `49933ea5288caeca8642d1e84afbd3f7d6820020`, upload-pages-artifact v3 `56afc609e74202658d3ffba0e8f6dda462b719fa`, deploy-pages v4 `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e`. Tag pins are mutable; SHAs are not. The donor's pins are the verified set (operator's production workflow).
3. **Trigger and concurrency.** `paths: site/**` so docs-01-style README-only changes never trigger a deploy; concurrency group `pages-deploy` so a push during an in-flight deploy cancels or queues deterministically rather than racing the Pages artifact.
4. **Node 24, npm ci.** The workflow uses node 24 with `npm ci` against the site's own lockfile — the npm/pnpm separation from docs-02 holds in CI exactly as locally.
5. **Verification is a fetch, not a badge.** The first deploy is proven by `curl` returning HTTP 200 from the live URL, pasted into evidence. A green workflow run proves the runner succeeded; only the fetch proves a reader can load the site (prior-context lesson: external integrations require at least one real-service test).
6. **Receipt evaluation is recorded, not manufactured.** Task 4.4 evaluates the first-party-page condition per pending release and writes the verdict with reasoning. A "partial" or "no" is a valid outcome; an unverified "yes" is not.

## Risks / Trade-offs

- [The literal ask is not honored] -> surfaced, not silently substituted: proposal, design and task 4.3 all state the `GITHUB_TOKEN` constraint; the operator chooses the route.
- [Pages enablement is a repo-settings mutation outside git] -> executed only with operator authorization; evidence records the API calls made.
- [Pinned SHAs age] -> accepted: the donor maintains the same pins; a deliberate alignment pass updates both sites together.
- [First deploy may fail on Pages enablement ordering] -> task 4.2 enables Pages before triggering the deploy; a failed first run is diagnosed, not retried blindly.

## Migration Plan

Nothing exists to migrate — no prior workflow, no prior Pages config. Rollback: `git revert` removes the workflow; Pages can be disabled in repo settings; the homepage field can be cleared with `gh repo edit --homepage ""`. All reversible.

## Open Questions

- **Whether forks should deploy Pages**: the donor workflow's behavior on forks is inherited unchanged; not evaluated in this change.
- **Custom domain** later: the `SITE_URL`/`BASE_URL` env pattern (docs-02) accommodates one without workflow changes; out of scope here.
