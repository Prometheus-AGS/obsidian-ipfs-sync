# First deploy evidence (task 4.2)

Date: 2026-10-12. Role: release-deployment-lead. Operator authorization: recorded in the KBD goal, 2026-10-12 ("run in goal mode until the site is complete and the github pages installed and running").

## Pages enablement

```
$ gh api repos/Prometheus-AGS/obsidian-ipfs-sync/pages -X POST -f "build_type=workflow"
{"url":"https://api.github.com/repos/Prometheus-AGS/obsidian-ipfs-sync/pages","status":null,"cname":null,"custom_404":false,"html_url":"https://prometheus-ags.github.io/obsidian-ipfs-sync/","build_type":"workflow","source":{"branch":"main","path":"/"},"public":true,"protected_domain_state":null,"pending_domain_unverified_at":null,"https_enforced":true}
$ gh api repos/Prometheus-AGS/obsidian-ipfs-sync/pages --jq '{url, build_type, status}'
{"build_type":"workflow","status":null,"url":"https://api.github.com/repos/Prometheus-AGS/obsidian-ipfs-sync/pages"}
```

## First run failed on enablement ordering (the design.md risk, observed)

The merge of PR #3 (merge commit `1cd7663`) triggered run `38239506567` before Pages was enabled. The build job failed at `actions/configure-pages`:

```
##[error]Get Pages site failed. Please verify that the repository has Pages enabled and configured to build using GitHub Actions, or consider exploring the `enablement` parameter for this action. Error: Not Found - https://docs.github.com/rest/pages/pages#get-a-apiname-pages-site
```

Diagnosed via `gh run view 38239506567 --log-failed` (not retried blindly): Pages enablement landed after the push. After enablement, the same run was rerun:

```
$ gh run rerun 38239506567 && gh run watch 38239506567 --exit-status
  ✓ build in 1m50s (ID 114779199916)
    ✓ Set up job
    ✓ Run actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
    ✓ Run actions/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b
    ✓ Run actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
    ✓ Run npm ci
    ✓ Run npm run build
    ✓ Run actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa
    ✓ Complete job
  ✓ deploy in 11s (ID 114779200054)
    ✓ Deploy Pages
    ✓ Complete job
```

(Job IDs from the rerun; step names abbreviated to the observed `gh run watch` output. Two Node-20 deprecation annotations were emitted for the pinned actions; the pins stay per design.md decision 2 — the donor maintains the same set.)

## Verification: real HTTP fetch, not a badge

```
$ curl -sS -o /dev/null -w '%{http_code}\n' https://prometheus-ags.github.io/obsidian-ipfs-sync/
200
$ curl -sS https://prometheus-ags.github.io/obsidian-ipfs-sync/ | grep -io '<title[^>]*>[^<]*'
<title data-rh="true">IPFS Sync for Obsidian
```

The served page is the KnowMe-branded site: navbar logo `/obsidian-ipfs-sync/img/knowme-conviction.svg`, hero "Sync your vault over IPFS.", documentation map linking Setup / Concepts / CLI / Security / Limitations / Evidence, footer "Copyright © 2026 Prometheus AGS. MIT License." The baseUrl-issue banner script is present in every Docusaurus build and does not fire when `window.docusaurus` loads; assets resolve under `/obsidian-ipfs-sync/` as configured. The evidence page requires a trailing-slash-aware fetch (`curl -sSL …/docs/evidence` → 200; the bare path returns nginx 301, which is normal GitHub Pages behavior).
