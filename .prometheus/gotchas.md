# gotchas

Append-only. Dated entries. Mark superseded entries; do not delete them.

## 2026-09-29
- Initialized by prometheus-context-bootstrap.
- 2026-09-29 — kbd runtime legacy migration: the first typed `prometheus kbd` mutation imports `progress.json.changes[]` as canonical changes. Update the legacy progress to the current plan **before** the first typed command. Imported changes keep their 0-based sequences, and `change register` rejects existing IDs, so carried-over changes can tie with new ones (mvp: 01/02 at 1, 04/05 at 4; ID order currently breaks ties correctly). There is no typed re-sequence command.
- 2026-09-29 — kubo-rpc-client 7.1.0 `files/write` sends multipart field `file`/`file-N`; the prometheusags proxy requires `data`. Only the `src/kubo` wrapper may issue `files/write`.
- 2026-09-30 — kubo name/resolve caches for the record TTL; always send nocache=true (src/kubo/ipns.ts).
- 2026-09-30 — pull trusts manifest paths: with an open-write node a forged manifest can write .obsidian/plugins/*/main.js on the pulling device (code execution) — mitigated only by the fixture-only guard now; mvp-06/07 must authenticate the manifest (AEAD) and refuse executable/config paths by default; no cap on manifest entries/size yet.
- 2026-09-30 — symlink TOCTOU window between lstat and rename in pull.
- 2026-09-30 — Obsidian WebView fetch is CORS-blocked by the node (403 for Origin app://obsidian.md, no ACAO headers on the OPTIONS preflight): the plugin must use requestUrl (src/plugin/request-url-transport.ts); node-side tests cannot detect this. files/write bodies are prebuilt multipart bytes (src/kubo/multipart.ts, field `data`) because requestUrl cannot send FormData.
- 2026-09-30 — forged-manifest mitigation partially in place: pull now refuses manifest paths that match the effective exclusion list or lie under `.obsidian/plugins/` (counted failed, exit 1), and `.obsidian/plugins/` is a default exclusion (never published). Still open: the manifest itself is unauthenticated (mvp-06/07), and there is no cap on manifest entries or size.
- 2026-09-30 — delivery-cadence source freeze fingerprints the WHOLE repo (git diff + untracked, except .prometheus/cadence), including .kbd-orchestrator state and .prometheus/*. Any typed KBD transition, decision-log or gotchas edit after `ready` makes `finish` refuse ("Sources changed since ready"). Rules: (1) finish all KBD/doc bookkeeping BEFORE `ready`; (2) operator-run tasks (the in-app run, release steps) must NOT be in the increment's cadence scope — complete them in KBD AFTER `finish`; (3) never write files into the repo while a checkpoint runs (inputs live outside the repo).
