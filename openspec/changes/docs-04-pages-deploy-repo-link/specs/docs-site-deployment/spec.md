## Purpose

Defines deployment of the docs site to GitHub Pages: a deployment-only workflow with pinned action SHAs, a verified first deploy, the About-link route with its authorization boundary, and an honest evaluation of the pending publication receipts.

## ADDED Requirements

### Requirement: Deployment-only workflow with pinned actions
`.github/workflows/docs-pages.yml` SHALL build and deploy the site and SHALL NOT run tests in CI. Every action SHALL be pinned by full commit SHA: checkout v4 `34e114876b0b11c390a56381ad16ebd13914f8d5`, configure-pages v5 `983d7736d9b0ae728b81ab479565c72886d7745b`, setup-node v4 `49933ea5288caeca8642d1e84afbd3f7d6820020`, upload-pages-artifact v3 `56afc609e74202658d3ffba0e8f6dda462b719fa`, deploy-pages v4 `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e`. The workflow SHALL trigger on `paths: site/**`, use concurrency group `pages-deploy`, run node 24, and build with `npm ci` + `npm run build` in `site/`.

#### Scenario: Pin audit
- **WHEN** the workflow file is grepped for action references
- **THEN** every action resolves to a full 40-character SHA and no test step exists

### Requirement: First deploy verified by a real fetch
The first deployment SHALL be verified by an HTTP 200 response from `https://prometheus-ags.github.io/obsidian-ipfs-sync/`, with the fetch command and output pasted into the change's evidence. A green workflow badge SHALL NOT be accepted as verification.

#### Scenario: Live URL fetch
- **WHEN** `curl -sS -o /dev/null -w '%{http_code}\n' https://prometheus-ags.github.io/obsidian-ipfs-sync/` runs after the deploy
- **THEN** it prints `200` and the output is committed as evidence

### Requirement: About link honors the authorization boundary
The repository homepage SHALL be set by a one-time operator-authorized `gh repo edit --homepage <pages-url>` (recommended route), or by a PAT-secret-backed workflow step only if the operator rejects the one-time route. The task SHALL execute only after operator authorization, SHALL record that `GITHUB_TOKEN` cannot edit repository metadata (Update-a-repository requires Administration write), and SHALL record an operator refusal as the outcome rather than fabricating success.

#### Scenario: Homepage readback
- **WHEN** `gh api repos/Prometheus-AGS/obsidian-ipfs-sync --jq .homepage` runs after the authorized step
- **THEN** it prints `https://prometheus-ags.github.io/obsidian-ipfs-sync/` and the output is committed as evidence

### Requirement: Publication receipts are evaluated, not fabricated
The change SHALL evaluate whether the deployed site satisfies the first-party-page condition for the pending v0.2.0/v0.3.0/v0.4.0 publication receipts and SHALL record the verdict (yes/no/partial per release, with reasoning) in an evidence note. No receipt SHALL be produced that was not actually earned.

#### Scenario: Evidence note verdict
- **WHEN** the evidence note is read
- **THEN** each pending release carries a verdict with reasoning, and any unsatisfied condition is named
