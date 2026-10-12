# Publication-receipt evaluation (task 4.4)

Date: 2026-10-12. Role: release-deployment-lead. Evaluation only — no receipt was produced by this change, and none is claimed.

(The parent dispatch named this file `publication-receipt-evaluation.md`; tasks.md names `publication-receipts.md`. The dispatch name was used; the content is the same evaluation.)

## The condition being evaluated

The receipt tool (`.claude/skills/delivery-cadence/scripts/publication-receipt.mjs`) requires, per release:

1. A first-party website reachable over HTTPS (`websiteUrl`, response 200; the page HTML plus its same-origin script bundles are the searched content).
2. The page content literally containing the release **version string** and each artifact's **absolute HTTPS URL** (`content.includes(artifact.url)` and `content.includes(input.version)`).
3. Each artifact URL returning downloadable bytes whose sha256 and size match the local artifact exactly.

Until this change, condition 1 had never been satisfiable: no first-party page existed (mvp reflection, debt item 8: "Publication receipts were never produced — v0.2.0, v0.3.0, v0.4.0 all record 'pending — no first-party page with absolute asset URLs exists'").

## What the deployed site now provides

- A public first-party page exists and is readable over HTTPS: `https://prometheus-ags.github.io/obsidian-ipfs-sync/` returns 200 (evidence: `first-deploy.md`).
- The site names all three pending releases. The evidence page (`/docs/evidence`) contains the literal strings `v0.2.0`, `v0.3.0`, `v0.4.0` and states each release's standing honestly (verified by fetching the live page, 2026-10-12).
- The GitHub releases themselves exist as public pre-releases with downloadable assets (verified via `gh release view`): v0.2.0 (`ipfs-sync-cli-0.2.0.tgz`, `main.js`, `manifest.json`, `SHA256SUMS`), v0.3.0 and v0.4.0 (same asset shape, versioned tarball names).

## What it does NOT provide

- **No absolute asset URLs.** The evidence page — and every other page on the site — contains no `https://github.com/Prometheus-AGS/obsidian-ipfs-sync/releases/download/...` link (grep of the live HTML for `releases/` URLs returns zero matches). The receipt tool's `content.includes(artifact.url)` check would throw `Website does not advertise <platform> URL and version` for every release today.
- The receipt tool also requires the downloaded bytes to match the local artifacts by sha256; that half is only evaluable at receipt-run time and was not run.

## Verdict per release

| Release | First-party page exists (condition 1) | Version named on page (part of 2) | Absolute asset URLs advertised (part of 2) | Receipt |
| --- | --- | --- | --- | --- |
| v0.2.0 | yes (new) | yes | no | **partial — not satisfiable yet** |
| v0.3.0 | yes (new) | yes | no | **partial — not satisfiable yet** |
| v0.4.0 | yes (new) | yes | no | **partial — not satisfiable yet** |

The deployed site is **not** a release-attestation page per release, and I do not judge the evidence page sufficient: the receipt contract is literal — the page must carry the absolute artifact URLs, and it carries none. This is a gap in the page, not a judgment that the releases are unpublishable.

## What would close it

Adding the three releases' absolute asset URLs (and version strings, already present) to a first-party page — the evidence page or a dedicated releases page — is a site-content change owned by docs-03's owners (documentation-specialist / uiux-lead), out of this change's scope. After that content lands and deploys, the receipts for v0.2.0/v0.3.0/v0.4.0 can be produced by running `publication-receipt.mjs` per release against the local artifacts. Until then, the receipts remain pending — honestly, as before, but the blocking condition is now reduced from "no first-party page exists" to "the page does not yet link the assets".
