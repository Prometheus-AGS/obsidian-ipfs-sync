## Why

The site from docs-02/docs-03 exists only on a workstation until it is deployed. This change adds the GitHub Pages deployment workflow (adapted from the donor's pinned-SHA `docs-pages.yml`), enables Pages, runs the first deploy, and verifies it with a real HTTP fetch. It also settles the repository About link and evaluates whether the deployed site satisfies the first-party-page condition for the pending v0.2.0/v0.3.0/v0.4.0 publication receipts.

The uncomfortable part: the user's literal ask — "the github action sets up the About link" — is not achievable as stated. `GITHUB_TOKEN` cannot edit repository metadata: the Update-a-repository endpoint requires Administration write, which the workflow token does not have. Presenting a green workflow as if it had set the link would be a fabricated receipt. This change records the constraint in design.md, recommends a one-time operator-authorized `gh repo edit --homepage`, keeps a PAT-secret-backed workflow step as the documented fallback, and executes the outward step only after operator authorization. Second discomfort: the first deploy is verified by an HTTP 200 fetch of the live URL, not by a green workflow badge — a badge proves the runner succeeded, not that anyone can read the site.

## What Changes

- New `.github/workflows/docs-pages.yml`: deployment-only (no tests in CI — local gates only, per the donor's policy), pinned action SHAs (checkout v4 `34e114876b0b11c390a56381ad16ebd13914f8d5`, configure-pages v5 `983d7736d9b0ae728b81ab479565c72886d7745b`, setup-node v4 `49933ea5288caeca8642d1e84afbd3f7d6820020`, upload-pages-artifact v3 `56afc609e74202658d3ffba0e8f6dda462b719fa`, deploy-pages v4 `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e`), trigger `paths: site/**`, concurrency group `pages-deploy`, node 24, `npm ci` + `npm run build` in `site/`.
- GitHub Pages enabled (repo settings → Pages → GitHub Actions source; `gh api` permitted with operator authorization) and the first deploy run, verified by a real HTTP 200 fetch of `https://prometheus-ags.github.io/obsidian-ipfs-sync/` with output pasted as evidence.
- About link: decision recorded in design.md; the chosen route executes only after operator authorization; verified by `gh api repos/Prometheus-AGS/obsidian-ipfs-sync --jq .homepage` printing the Pages URL.
- An evidence note recording whether the deployed site satisfies the first-party-page condition for the pending v0.2.0/v0.3.0/v0.4.0 publication receipts — evaluation and recording only, no fabricated receipts.
- No site content changes (docs-03 owns content); no root manifest changes.

## Capabilities

### New Capabilities
- `docs-site-deployment`: the pinned-SHA deployment-only Pages workflow, the verified first deploy, the About-link route with its authorization boundary, and the publication-receipt evaluation.

### Modified Capabilities
<!-- none: openspec/specs/ is empty; the delta is ADDED -->

## Impact

- New: `.github/workflows/docs-pages.yml` (the repo's first workflow — no `.github/` exists today).
- Outward: GitHub Pages enablement and repository homepage metadata — both require operator authorization; the About-link step is a recorded decision, not a silent substitution.
- Owner: release-deployment-lead (sole publisher per the team rule).
- Depends on: docs-03 (content and its gate); the docs-03 content gate must be green before the first deploy.
- Evidence: `openspec/changes/docs-04-pages-deploy-repo-link/evidence/` — the HTTP 200 fetch output, the `gh api` homepage readback, and the publication-receipt evaluation note.
