# mvp-10 demo record — real-vault round trip and Release 3 (v0.4.0)

This is the single record for `openspec/changes/mvp-10-real-vault-publish-and-release`.
Sections 1–6 are filled during the operator-run demo (the run-sheets
`mvp-10-secret-scan.md` and `mvp-10-demo-run.md` carry the procedures); sections 7–9 are
filled by the team at tasks 5.2/5.3/6.1/6.2. Task 6.2 checks every section is present.

Absolute rules (from the run-sheets): no file contents, no key material, no matched secret
text in this record — names only, abbreviated (first 20 chars of the vault-relative path +
`…` + length). Scan reports live under `/tmp/` and are deleted after adjudication.

## 0. Pre-demo node baseline (read-only, captured by lead 2026-10-06)

`ipfs files ls /obsidian-vault-sync` (kubectl context `know-me`, namespace `ipfs`, pod
`ipfs-0`, container `ipfs`) — 13 roots:

```
mvp02-demo mvp03-demo mvp04-demo mvp05-demo mvp06-demo mvp06-probe mvp07a-demo
mvp07b-demo mvp08-demo phone-test-1 phone-test-big publish-real-20260929 real-obsidian
```

`ipfs files ls -l /obsidian-vault-sync/real-obsidian`:

```
keyslots.json  bafkreifaiwkj3ubsr5xay64psolyksrxqxeklryp7ahvfhznnxe3kvx7y4  594
```

The demo root holds only the aborted-run `keyslots.json` — the adopt-path precondition of
task 2.3 (no `manifest.enc`, no other entries). The gate build the operator installs at 3.1:
`dist/plugin/main.js` sha256 `fd46e1050230383e865a4062a7024614ee9d9542c73dc2aa690de3500590423a`
(verified unchanged this date; no source file newer than the build).

## 1. Operator gate 2.1 — secret scan

Paste the filled template from `mvp-10-secret-scan.md` §4 here: scan tool name, tool
version, scan date, publishable-set size at scan time, content findings count,
OpenAI-key-shaped finding remaining (yes/no), overall verdict GO/NO-GO, and both
adjudication tables (content findings; all 36 name-list rows).

## 2. Operator gate 2.2 — OpenAI key rotation

- Rotation date: <YYYY-MM-DD>
- Old key revoked: <yes — where it was revoked>
- New key issued and stored: <yes — where it now lives>
- No key bytes in the repository, this record, or the publishable set (2.1 confirms the last): <confirmed>

## 3. Demo plan decisions (tasks 2.3d/D-D and the key decision)

- The 195.4 MiB file (`Obsidian-wiki/.llm-wiki/file-change-queue.json`):
  <raise read cap to ___ MB | exclude it>
- `.llm-wiki/` (1,461 churning files): <stays in (default) | excluded>
- Publication key: <Option A — adopt `obsidian-vault-sync` (k51qzi5uqu5dicwvxyvqgk8iwhp7f4r30i7mj54qz3100sln5czk5xcp48jgqq), repoints the project name | Option B — fresh name `obsidian-vault-…`>
- User exclusion additions from 2.1, if any: <list or none>
- Exclusion hash shown by the settings tab at demo time: <hash>

## 4. Task 3.1 — publish (operator-run from Obsidian desktop)

- Installed build sha256 (must equal the §0 gate build): <hash>
- Settings confirmed per `mvp-10-demo-run.md` §3: <yes / deviations>
- Wall time: <>
- Bytes sent: <>
- File count published: <>
- Root CID: <>
- IPNS resolution result: <>
- Skipped files, one line each with reason (exclusion / read cap / changed-during-read /
  removed-during-read / dangling symlink): <>
- Plugin's own publish summary (paste): <>
- Read-only `files/stat` of `/obsidian-vault-sync/real-obsidian/manifest.enc` on the node
  (paste): <>

## 5. Task 3.2 — pull into a fresh vault and compare (operator-run)

- Fresh vault created; passphrase entered from the secrets file; pull-size dialog
  confirmed: <yes / notes>
- Published set size: <> | Pulled count: <> | Policy-skipped count: <>
- sha256 comparison output (paste; `shasum -a 256` over both trees, exclusion list
  applied): <>
- Mismatch count (acceptance: 0): <>
- Expected drift (files that churned after the publish — named, not mismatches): <>
- `ipfs-sync history` after a CLI restart lists the publish and the pull from the on-disk
  database (paste): <>

## 6. Task 3.3 — mobile attempt (optional)

<either: device, OS, Obsidian build, procedure, outcome — or the line
"not run — mobile stays unverified (T3)">

## 7. Release record and approval evidence (tasks 5.2, 5.3 — team fills)

- Release record path: <>
- Packaged assets under `dist/release/v0.4.0/` and checksum re-verification (paste): <>
- Operator approval text reference (pre-approval recorded in
  `.kbd-orchestrator/phases/mvp/execution.md`, 2026-10-06 entry): <confirmed>
- `gh release view v0.4.0` output (paste): <>
- Publication receipt: <produced at … | pending — no first-party page with absolute asset URLs>

## 8. Cleanup evidence (task 6.1 — pre-approved, executed once)

- Confirmation source: operator pre-approval "demo-root cleanup after each feature op"
  (execution.md, 2026-10-06 entry)
- `files/ls /obsidian-vault-sync` before (paste): <>
- `files/rm -r /obsidian-vault-sync/publish-real-20260929` result: <>
- `files/ls /obsidian-vault-sync` after (paste — staging tree gone, nothing else changed): <>

## 9. Unverified list and goal statement (task 6.2 — team fills)

- Unverified: <mobile unless 3.3 ran; Android; non-macOS hosts; the CLI's missing read cap
  and exclusion option; metadata visibility per T4; the publication receipt if pending;
  authenticated endpoint>
- Supporting evidence cited, not re-run: mvp-09's green `pnpm test:e2e` run (2026-10-06,
  5/5 scenarios).
- Phase goals 6 and 7: <met — this record is the evidence | gap: …>
