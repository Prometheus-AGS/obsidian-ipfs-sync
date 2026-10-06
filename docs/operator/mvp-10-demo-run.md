# mvp-10 task 2.3 — adopt path, refreshed scale scan, demo settings checklist

Prepared by **ipfs-engineer** for the operator. `docs/operator/` is
documentation-specialist's ownership path; this file is an operational
run-sheet, placed here by lead dispatch because the operator reads
`docs/operator/` and this document is run, not maintained as product
documentation. It is a sibling of `mvp-10-secret-scan.md` (task 2.1)
because that file is scoped to the scan and this one is the demo-time
configuration checklist; keeping them one-per-task keeps each run-sheet
short.

Binding: `openspec/changes/mvp-10-real-vault-publish-and-release/tasks.md`
task 2.3 and `design.md` decisions D-A and D-D.

## 1. The adopt path (task 2.3a) — proven on a scratch root

The aborted-run state was reproduced on a throwaway root
(`/obsidian-vault-sync/mvp10-adopt-probe-20261006084849`, removed after):
`keyslots.json` on the node, a local slot copy in the vault's
`.ipfs-sync/`, no `manifest.enc`, no local state file.

**The resume route is a plain `publish` with the passphrase file. No
`--repair`, no flags.**

```bash
IPFS_SYNC_PASSPHRASE_FILE=/Users/gqadonis/.ipfs-sync-secrets/obsidian-real.pass \
  ipfs-sync publish <vault> --mfs-root /obsidian-vault-sync/real-obsidian
```

Proven sequence on the scratch root (CLI build from the task-1.2 gate,
`dist/cli/ipfs-sync.mjs`, Node v26.8.2, `PATH=/opt/homebrew/bin:$PATH`):

1. `init` wrote the vault (this is how the aborted state arises).
2. `init` again refused, as designed: "this device already holds a
   key-slot copy for this MFS root, so a vault exists here; init creates
   a vault only once" (exit 1). **`init` is not the resume route.**
3. `publish` with `IPFS_SYNC_PASSPHRASE_FILE` ran to completion: 11
   files written, `sequence 1`, root CID and IPNS record published, exit
   0.
4. A second `publish` printed "nothing changed: no new manifest, IPNS
   record not touched" (exit 0) — the local state written by the first
   publish is consistent with the node.

Why the manifest-missing refusal does not fire: it requires local state
(`src/sync/publish-refusals.ts:91-97` is only reached when this device
has a record of publishing here). With no local state and no
`manifest.enc`, `classifySequence(undefined, undefined)` returns
`first-publish` (`src/sync/sequence-rules.ts:28`), and `openVault`
unlocks the local slot copy and verifies it byte-for-byte against the
node's `keyslots.json` (origin `local-copy`, `src/sync/vault-keys.ts:211-222`).
The existing keyslots/passphrase pair is adopted as-is; D-A stands as
written, no amendment needed.

The plugin's Publish command runs the same engine path, so the same
adopt behaviour applies to the demo: the operator opens the vault in
Obsidian, enters the passphrase at the unlock dialog, and Publish
performs the first publish adopting the leftover slots.

## 2. Refreshed scale scan (task 2.3b) — read-only, 2026-10-06

Same read-only procedure as `mvp-10-secret-scan.md` section 1, re-run
today against `/Users/gqadonis/obsidian`:

| Measure | 2026-10-06 recorded | 2026-10-06 refreshed | Delta |
|---|---|---|---|
| Publishable files | 4,824 | 4,824 | none |
| Publishable bytes | 1,000,412,777 (954.1 MiB) | 1,000,412,777 (954.1 MiB) | none |
| Largest file | `Obsidian-wiki/.llm-wiki/file-change-queue.json`, 204,841,649 bytes (195.4 MiB) | same file, same size | none |
| `.llm-wiki/` files | 1,461 | 1,461 | none |
| Dangling symlinks | 2 | 2 (same two, under `tribe 2/Northell/.pub-cache/.../.bin/`) | none |

Next five largest publishable files after the 195 MiB one:
`conversational_analytics.pdf` 42,181,664; a Medium-export PDF
22,131,639; `Comprehensive Rust 🦀.pdf` 15,713,002; `deck.pdf`
14,746,688 (paths abbreviated; all well under the default read cap).

The numbers are unchanged, so the 2.1 scan run-sheet's scale facts
still hold verbatim.

## 3. Plugin settings checklist (task 2.3e) — confirm before the demo publish

The plugin is installed in the host vault
(`.obsidian/plugins/ipfs-sync/`) but has no `data.json` yet — nothing is
configured. **The installed `main.js` is not the demo build**: installed
sha256 `37d1a9d5…` (manifest version 0.1.0) vs the task-1.2 gate build
`dist/plugin/main.js` sha256 `fd46e105…`. Install the gate build first
(task 3.1 covers this).

Settings tab values to enter and confirm (field names as the tab labels
them; mapping to config in `src/plugin/settings-to-config.ts:41-56`):

| Section | Field | Value |
|---|---|---|
| Endpoints | RPC URL | `https://ipfs.prometheusags.ai` (RPC port empty) |
| Endpoints | Gateway URL | `https://ipfs.prometheusags.ai` (Gateway port empty) |
| Authentication | Authentication scheme | **None** — the shared node's RPC endpoint takes no credential (verified by the scratch publish: `auth: none`) |
| Authentication | Gateway authentication | **Same as node** (same origin, so no credential is sent) |
| Publication | MFS root | `/obsidian-vault-sync/real-obsidian` |
| Publication | Publication key name | see the key decision below |
| Exclusions | Your additions | only what the 2.1 adjudication added, if anything |
| Pull | Pull IPNS name | empty (pulls from the vault's own publication key) |
| Pull | Ask before pulling more than (MB) | default 512 — the fresh-vault pull (~954 MiB) will ask once; confirming it is expected, or raise it (max 8192) |
| Pull | Catch up on load | off |
| Memory | Read cap (MB) | see D-D below |
| Publication | Auto-publish interval (minutes) | 0 (off) for the demo |

**Publication key decision** (must match `^obsidian-vault(-[a-z0-9-]+)?$`,
`src/core/config/node-safety.ts:57`; the plugin publishes only to keys
listed under Owned key IDs):

- **Option A — keep the default name `obsidian-vault-sync`.** That key
  exists on the node (ID
  `k51qzi5uqu5dicwvxyvqgk8iwhp7f4r30i7mj54qz3100sln5czk5xcp48jgqq`) and
  currently points at the mvp-06 demo root. Publishing under it repoints
  the project's primary name from demo content to the real vault.
  Because this device has no recorded ownership, the key must first be
  adopted: Owned keys → "Adopt a key by ID" with the ID above.
- **Option B — a fresh name** (for example `obsidian-vault-real`). The
  first publish creates the key and records its ID under Owned key IDs
  automatically. `obsidian-vault-sync` keeps pointing at the demo root
  until something repoints it.

**Exclusions hash.** With no user additions the effective list is the
eight defaults and the hash the Exclusions section shows must be
`ebd10cbd1cd9776229910af44cc1455550e840ba6aad25e8ba9434b0df32da0f`
(recomputed today from `src/sync/exclusions.ts:107`). Any addition from
the 2.1 adjudication changes it — record the hash the tab shows at demo
time, not this one.

## 4. D-D decisions for the operator (record in the demo plan section)

**The 195.4 MiB file** (`Obsidian-wiki/.llm-wiki/file-change-queue.json`,
204,841,649 bytes) vs the read cap ("Read cap (MB)" in the Memory
section, whole MB 8–1024, default 64; `src/plugin/read-cap.ts:6-8`):

- [ ] **Raise the cap**: set Read cap (MB) to **196 or more** (256 is a
  round choice) for the run. The file is then read into memory whole on
  publish and pull — desktop-class memory use.
- [ ] **Exclude it**: add `Obsidian-wiki/.llm-wiki/file-change-queue.json`
  under Exclusions → Your additions. It is then skipped by name and the
  exclusion hash changes (record the new hash).

**The `.llm-wiki/` folder** (1,461 churning files):

- [ ] **Stays in** (default; it is the churn the hardening exists for).
- [ ] Excluded (add `Obsidian-wiki/.llm-wiki/`; record the hash change).
