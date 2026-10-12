# About-link evidence (task 4.3)

Date: 2026-10-12. Role: release-deployment-lead. Route: the recommended route recorded in design.md — one-time operator-authorized `gh repo edit --homepage` (operator authorization recorded in the KBD goal, 2026-10-12). The fallback PAT-secret workflow step was not used; no secret was created.

## Command and readback

```
$ gh repo edit Prometheus-AGS/obsidian-ipfs-sync --homepage https://prometheus-ags.github.io/obsidian-ipfs-sync/
(command exited 0; no output)
$ gh api repos/Prometheus-AGS/obsidian-ipfs-sync --jq .homepage
https://prometheus-ags.github.io/obsidian-ipfs-sync/
```

The readback prints the Pages URL. The repository About section now links to the deployed docs site.
