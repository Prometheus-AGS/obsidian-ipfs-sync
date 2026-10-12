# mvp-10 task 2.1 — secret scan of the real vault (operator run-sheet)

Prepared by **ipfs-engineer** for the operator. `docs/operator/` is
documentation-specialist's ownership path; this file is an operational
run-sheet, placed here by lead dispatch because the operator reads
`docs/operator/` and this document is run, not maintained as product
documentation.

Binding: `openspec/changes/mvp-10-real-vault-publish-and-release/tasks.md`
task 2.1. The scan runs **before any publish of the real vault**. The
operator chooses the tool, runs it, and adjudicates every finding. An agent
running the scan or the publish invalidates the demo.

Absolute rules:

- No file contents, no key material, no matched secret text enters this
  repository or the demo record — names only, abbreviated (first 20
  characters of the vault-relative path + `…` + length).
- All vault access is read-only (`find`/`stat`-class).
- Scan reports live under `/tmp/` and are deleted after adjudication; only
  verdicts are recorded.

## 1. The publishable set (what the scan must cover)

The publish would carry every file the default exclusions leave in. The
defaults (`src/sync/exclusions.ts:9-18`, matched per path segment at any
depth):

```
.trash/  .ipfs-sync/  .ipfs-sync-fixture  .DS_Store  .obsidian/  node_modules/  .git/  .smart-env/
```

Nested vaults: they are ordinary directories — their notes **are**
published. Only their own `.obsidian/`, `.git/`, etc. segments are excluded.
There is no "skip nested vaults" behavior.

Enumerate the publishable set (read-only, exact equivalent of the plugin's
defaults):

```bash
find /Users/gqadonis/obsidian \
  \( -type d \( -name .trash -o -name .ipfs-sync -o -name .obsidian \
                -o -name node_modules -o -name .git -o -name .smart-env \) -prune \) \
  -o -type f ! -name .DS_Store ! -name .ipfs-sync-fixture -print \
  | sed 's|^/Users/gqadonis/obsidian/||' | LC_ALL=C sort > /tmp/mvp10-publishable.txt
wc -l /tmp/mvp10-publishable.txt
```

Scale at preparation time (ipfs-engineer, read-only, 2026-10-06; task 2.3
re-refreshes at the demo): **4,824 files / 1,000,412,777 bytes (954 MiB)**.
Known scale facts that shape the scan: one 195 MiB file
(`Obsidian-wiki/.llm-wiki/file-change-queue.json`, 204,841,649 bytes — a
`.llm-wiki/` churn file, 1,461 files in that folder) and 2 dangling
symlinks (silently skipped by the publish).

## 2. The 36 secret-like note names

Provenance, stated plainly: the 2026-10-05 read-only scan recorded the
count (36) in the handoff but never persisted the list in the repo. This
list is a **reconstruction** (2026-10-06) that reproduces the count exactly:
`.md` basenames in the publishable set matching the case-insensitive pattern
`password|secret|credential|cert|gpg`. The operator must regenerate the
full names locally and adjudicate from those, not from the abbreviations:

```bash
grep -iE 'password|secret|credential|cert|gpg' <( \
  find /Users/gqadonis/obsidian \
    \( -type d \( -name .trash -o -name .ipfs-sync -o -name .obsidian \
                  -o -name node_modules -o -name .git -o -name .smart-env \) -prune \) \
    -o -type f -name '*.md' -print | sed 's|^/Users/gqadonis/obsidian/||' \
) | LC_ALL=C sort
```

The 36 names, abbreviated (vault-relative path, first 20 chars + length,
matched keyword):

```
 1. Obsidian-wiki/wiki/c… (len 61)  kw: cert
 2. Obsidian-wiki/wiki/c… (len 45)  kw: cert
 3. TRemote/Azure/Passwo… (len 25)  kw: password
 4. cal.com/Password.md… (len 19)  kw: password
 5. pinata/Credentials f… (len 31)  kw: credential
 6. prometheus/postgres/… (len 40)  kw: password
 7. skytok/Bsky App Pass… (len 27)  kw: password
 8. tribe 2/1Password.md… (len 20)  kw: password
 9. tribe 2/AT&T/Site Pa… (len 29)  kw: password
10. tribe 2/Azure/Passwo… (len 25)  kw: password
11. tribe 2/BitBucket fo… (len 44)  kw: password
12. tribe 2/GPG Notes an… (len 49)  kw: password, gpg
13. tribe 2/ITForP passw… (len 26)  kw: password
14. tribe 2/Iota/Shimmer… (len 46)  kw: password
15. tribe 2/Musiq Soulch… (len 74)  kw: cert
16. tribe 2/Proem/Passwo… (len 36)  kw: password
17. tribe 2/QuickBooks/P… (len 30)  kw: password
18. tribe 2/Tribe Core/U… (len 66)  kw: gpg
19. tribe 2/budibase/sec… (len 27)  kw: secret
20. tribe 2/code interpr… (len 53)  kw: password
21. tribe 2/livekit/Edus… (len 39)  kw: credential
22. tribe 2/medcom/AWS C… (len 37)  kw: credential
23. tribe 2/medcom/AWS P… (len 39)  kw: password
24. tribe 2/memphis/Loca… (len 46)  kw: password
25. tribe 2/microk8s/CA … (len 27)  kw: cert
26. tribe 2/microk8s/CRD… (len 47)  kw: cert
27. tribe 2/mindtrust/ma… (len 48)  kw: credential
28. tribe 2/mindtrust/sy… (len 44)  kw: password
29. tribe 2/minikube/Sel… (len 37)  kw: cert
30. tribe 2/minikube/Sel… (len 39)  kw: cert
31. tribe 2/personal/AT&… (len 33)  kw: password
32. tribe 2/stanley/Pass… (len 27)  kw: password
33. tribe 2/supabase/My … (len 38)  kw: password
34. tribe 2/syra/Argo Ad… (len 35)  kw: password
35. tribe 2/tribe health… (len 45)  kw: password
36. tribe 2/tribemedia/A… (len 39)  kw: password
```

## 3. Content scan procedure (operator picks one tool, or runs several)

The name scan above only covers file names. The content scan looks for
secret material inside the publishable files. The project itself is
no-Python (`no-python` constraint) — that binds the repo, not the operator's
choice of scanner; all options below are Go/Rust binaries.

Whichever tool runs: scan the whole vault root (simpler and safer than
staging), then keep only findings whose path is in
`/tmp/mvp10-publishable.txt` (section 1). Never paste unfiltered or
unredacted output.

**Option A — gitleaks** (`brew install gitleaks`; `gitleaks dir` scans a
directory tree without git context):

```bash
gitleaks dir /Users/gqadonis/obsidian --redact \
  --report-format json --report-path /tmp/mvp10-gitleaks.json
# findings inside the publishable set:
jq -r '.[].File' /tmp/mvp10-gitleaks.json | sort -u > /tmp/mvp10-findings.txt
comm -12 <(sed 's|^|/Users/gqadonis/obsidian/|' /tmp/mvp10-publishable.txt) /tmp/mvp10-findings.txt
```

**Option B — trufflehog** (`brew install trufflehog`; verifies credentials
live where possible — verification contacts the credential's issuer, so run
`--no-update --only-verified` first, then a full run if wanted):

```bash
trufflehog filesystem --no-update --only-verified --json /Users/gqadonis/obsidian \
  > /tmp/mvp10-trufflehog.json
jq -r '.SourceMetadata.Data.Filesystem.file // empty' /tmp/mvp10-trufflehog.json | sort -u
```

**Option C — ripsecrets** (`brew install ripsecrets`; fast, fewest rules —
use as a second opinion, not alone):

```bash
ripsecrets /Users/gqadonis/obsidian
```

Adjudication per finding, one of exactly four verdicts:

- **rotated** — the credential was live; it has been rotated/revoked
  (record the rotation date; this is where task 2.2's OpenAI key lands).
- **removed** — the secret material was edited out of the note before the
  scan verdict is recorded.
- **excluded** — the path was added to the plugin's user exclusions, so the
  publish never carries it (record the added exclusion entry; it changes
  the exclusion hash verified at 2.3).
- **false positive** — no live credential (one-line reason, no content).

The record must also state explicitly whether any OpenAI-key-shaped finding
remains in the publishable set (the one known-leaked key, task 2.2).

## 4. Record template (the demo record consumes this)

Copy this block into the demo record and fill every field:

```markdown
## Operator gate 2.1 — secret scan

- Name-scan list provenance: reconstructed 2026-10-06, pattern
  `password|secret|credential|cert|gpg` on publishable `.md` basenames,
  count 36 (2026-10-05 scan recorded the count only; list not persisted).
- Content scan tool: <name>
- Tool version: <x.y.z> (paste `<tool> --version`)
- Scan date: <YYYY-MM-DD>
- Publishable set at scan time: <N> files / <bytes> bytes
- Content findings in the publishable set: <N>
- OpenAI-key-shaped finding remaining in publishable set: yes / no
- Overall verdict: GO / NO-GO

### Content findings adjudication

| # | file (abbreviated, first 20 chars + len) | detector rule | verdict (rotated/removed/excluded/false positive) | note (no content) |
|---|------------------------------------------|---------------|---------------------------------------------------|-------------------|

### Name-list adjudication (36/36 required)

| # | name (abbreviated) | len | kw | verdict | note (no content) |
|---|--------------------|-----|----|---------|-------------------|
| 1 | Obsidian-wiki/wiki/c… | 61 | cert | | |
| 2 | Obsidian-wiki/wiki/c… | 45 | cert | | |
| 3 | TRemote/Azure/Passwo… | 25 | password | | |
| 4 | cal.com/Password.md… | 19 | password | | |
| 5 | pinata/Credentials f… | 31 | credential | | |
| 6 | prometheus/postgres/… | 40 | password | | |
| 7 | skytok/Bsky App Pass… | 27 | password | | |
| 8 | tribe 2/1Password.md… | 20 | password | | |
| 9 | tribe 2/AT&T/Site Pa… | 29 | password | | |
| 10 | tribe 2/Azure/Passwo… | 25 | password | | |
| 11 | tribe 2/BitBucket fo… | 44 | password | | |
| 12 | tribe 2/GPG Notes an… | 49 | password, gpg | | |
| 13 | tribe 2/ITForP passw… | 26 | password | | |
| 14 | tribe 2/Iota/Shimmer… | 46 | password | | |
| 15 | tribe 2/Musiq Soulch… | 74 | cert | | |
| 16 | tribe 2/Proem/Passwo… | 36 | password | | |
| 17 | tribe 2/QuickBooks/P… | 30 | password | | |
| 18 | tribe 2/Tribe Core/U… | 66 | gpg | | |
| 19 | tribe 2/budibase/sec… | 27 | secret | | |
| 20 | tribe 2/code interpr… | 53 | password | | |
| 21 | tribe 2/livekit/Edus… | 39 | credential | | |
| 22 | tribe 2/medcom/AWS C… | 37 | credential | | |
| 23 | tribe 2/medcom/AWS P… | 39 | password | | |
| 24 | tribe 2/memphis/Loca… | 46 | password | | |
| 25 | tribe 2/microk8s/CA … | 27 | cert | | |
| 26 | tribe 2/microk8s/CRD… | 47 | cert | | |
| 27 | tribe 2/mindtrust/ma… | 48 | credential | | |
| 28 | tribe 2/mindtrust/sy… | 44 | password | | |
| 29 | tribe 2/minikube/Sel… | 37 | cert | | |
| 30 | tribe 2/minikube/Sel… | 39 | cert | | |
| 31 | tribe 2/personal/AT&… | 33 | password | | |
| 32 | tribe 2/stanley/Pass… | 27 | password | | |
| 33 | tribe 2/supabase/My … | 38 | password | | |
| 34 | tribe 2/syra/Argo Ad… | 35 | password | | |
| 35 | tribe 2/tribe health… | 45 | password | | |
| 36 | tribe 2/tribemedia/A… | 39 | password | | |
```
