# MFS delta-sync data model

## Manifest — `.ipfs-sync.manifest.json`

```json
{
  "version": 1,
  "publishedAt": "2026-09-29T19:00:00Z",
  "rootCid": "bafy…",
  "excludesHash": "sha256:…",
  "files": [
    { "path": "notes/daily.md", "size": 1234, "mtimeMs": 1759…, "cid": "bafy…", "sha256": "…" }
  ]
}
```

- `excludesHash`: sha256 over the JSON of the sorted exclusion list. Two
  devices with different exclusion sets produce different hashes; on mismatch
  the pulling device publishes a full manifest (never a partial delta) and the
  UI warns. Rationale in spec 011 — divergence must be loud, not silent.
- `cid` is the file's raw IPFS CID (fetchable via `cat` without MFS);
  `path` is the vault-relative POSIX path.
- The manifest itself is content-addressed and replaced whole on each publish;
  do not attempt per-entry patching.

## `root` pointer file

`/obsidian-vault-sync/root` contains exactly one CID (the manifest CID of the
current tree) plus a trailing newline. Atomic repoint = one `files/write` of
≤64 bytes. IPNS points at the MFS root, not at a snapshot — pull resolves
IPNS → reads `root` → fetches manifest → diffs.

## Staging lifecycle

1. `files/mkdir /obsidian-vault-sync/staging-<ts>` (`parents=true`).
2. Per-file `files/write` of changed files (query-string args, multipart `data`).
3. `files/stat` every written path; abort publish on any size mismatch.
4. Write manifest into staging, read back its CID via `files/stat --hash`.
5. `files/write` `root` = manifest CID.
6. `name/publish` (key `obsidian-vault`), then `name/resolve --nocache` to prove it.
7. Best-effort `files/rm -r` of the previous staging tree. Never delete the
   tree `root` currently references.

## Pull diff algorithm

1. Resolve IPNS; on timeout keep the last-known root and mark sync "stale".
2. Fetch manifest; compare `excludesHash` with local — mismatch → full sync.
3. For each entry: if local file missing → fetch. If `sha256` differs → fetch.
   If local file newer by `mtimeMs` and sha differs → conflict: remote wins,
   local preserved as ` (ipfs conflict YYYY-MM-DD)` copy.
4. Write new manifest locally last; only then update `lastPulledRoot`.
