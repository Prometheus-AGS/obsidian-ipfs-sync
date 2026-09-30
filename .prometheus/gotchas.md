# gotchas

Append-only. Dated entries. Mark superseded entries; do not delete them.

## 2026-09-29
- Initialized by prometheus-context-bootstrap.
- 2026-09-29 — kbd runtime legacy migration: the first typed `prometheus kbd` mutation imports `progress.json.changes[]` as canonical changes. Update the legacy progress to the current plan **before** the first typed command. Imported changes keep their 0-based sequences, and `change register` rejects existing IDs, so carried-over changes can tie with new ones (mvp: 01/02 at 1, 04/05 at 4; ID order currently breaks ties correctly). There is no typed re-sequence command.
- 2026-09-29 — kubo-rpc-client 7.1.0 `files/write` sends multipart field `file`/`file-N`; the prometheusags proxy requires `data`. Only the `src/kubo` wrapper may issue `files/write`.
