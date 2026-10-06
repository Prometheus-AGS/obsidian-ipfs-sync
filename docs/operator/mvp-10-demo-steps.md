# mvp-10 demo walkthrough — the real-vault round trip, step by step

This document explains **every step of the Release 3 demo**, in order, with the reason
each step exists. The commands and checklists themselves live in two run-sheets —
`mvp-10-secret-scan.md` (task 2.1) and `mvp-10-demo-run.md` (tasks 2.3/3.1) — and the
evidence you collect lands in one file, `mvp-10-demo-record.md`. This walkthrough is the
map; those are the instruments.

Binding: `openspec/changes/mvp-10-real-vault-publish-and-release/` (proposal, tasks).
Nothing here overrides the tasks; where they differ, the tasks win.

## Why this demo exists

Everything up to now was proven against **fixture vaults** — synthetic trees under
`/tmp`, a few megabytes. Phase goals 6 and 7 are not met until the **operator's real
vault** — nested vaults, ~1.5 GB on disk, 4,824 files / ~954 MiB after the default
exclusions — has been published **encrypted from inside Obsidian** and reproduced into a
fresh vault with **zero content mismatches**. Fixtures cannot prove that, because the
real vault has the properties that break sync tools: thousands of small files, one
195 MiB file, files that change *while the publish is reading them* (`.llm-wiki/`,
1,461 churning files), and dangling symlinks.

The demo is also the evidence Release 3 (v0.4.0) ships with: the release notes and the
README state the demo's observed numbers, so the numbers must exist and be recorded.

## Why your hands, not the agent's

On 2026-10-05 an agent's upload of the real directory was denied by the permission
layer, and you then said not to publish it. The standing rule from that handoff: **every
action that touches the real vault or writes real content to the node is operator-run.**
An agent executing the scan, the rotation, the publish, or the pull demo invalidates the
demo as evidence — the record would have to say "the agent did it," which is precisely
the failure the rule exists to prevent. The agent prepares, verifies, and records; you
run the steps.

There is also a hard information asymmetry: only you can say whether a credential in a
note is live (Step 1) and only you can revoke a key in the OpenAI dashboard (Step 2).

## Step 1 — Secret scan of the vault (task 2.1)

**Why.** The publish encrypts everything before it leaves the machine, so this is no
longer about plaintext exposure — encryption is unconditional since mvp-06. The gate is
about what you *knowingly* encrypt and upload to a shared kubo node whose DHT
announcements are public. The vault is known to contain at least one leaked OpenAI key,
and a read-only scan on 2026-10-05 found **36 note names** that look secret-like
(`password|secret|credential|cert|gpg` in the basename). Encryption hides content from
the node operator; it does not make a leaked credential unleaked, and it does not stop
*you* from archiving secrets you meant to delete onto a server.

**What to do.** Full procedure in `mvp-10-secret-scan.md`:

1. Enumerate the publishable set (§1 — a `find` command that mirrors the plugin's
   default exclusions exactly).
2. Regenerate the 36-name list locally (§2 — the repo only holds abbreviations, never
   full paths) and adjudicate each name: **rotated** / **removed** / **excluded** /
   **false positive**.
3. Run a content scanner of your choice over the vault (§3 — gitleaks, trufflehog, or
   ripsecrets; all read-only), keep only findings inside the publishable set, adjudicate
   each the same way.
4. Fill section 1 of `mvp-10-demo-record.md` (tool name + version, scan date, verdicts,
   GO/NO-GO).

**Rules.** Read-only tools only. No file contents or secret text in the repo or the
record — names abbreviated. Scan reports live in `/tmp/` and are deleted afterwards.
Any "excluded" verdict adds a user exclusion in the plugin settings, which changes the
exclusion hash — that hash is recorded at demo time (Step 3).

## Step 2 — Rotate the leaked OpenAI key (task 2.2)

**Why.** A key that appeared in the vault was exposed outside it (that is how the leak
is known). Rotation is the only action that actually ends the exposure — scanning,
excluding, and encrypting only change who can see the *copy*. This step happens outside
the repository entirely: revoke the old key in the OpenAI dashboard, issue a new one,
update wherever you keep it.

**What to record.** Section 2 of the demo record: the rotation date, that the old key
was revoked, and that no key bytes exist in the repo, the record, or the publishable set
(the Step 1 scan confirms the last). No key material anywhere, ever.

## Step 3 — Three decisions before the publish (tasks 2.3d / D-D)

These are operator decisions because they trade real costs only you can weigh. Record
them in section 3 of the demo record.

**3a. The 195.4 MiB file** (`Obsidian-wiki/.llm-wiki/file-change-queue.json`).
The plugin's read cap (default 64 MB) exists so a publish cannot exhaust memory by
reading a huge file whole. This file exceeds it.

- *Raise the cap to 256 MB*: the file is published and pulled like any other, at the
  cost of a ~200 MB in-memory read on both sides. Desktop-class, fine.
- *Exclude it*: skipped by name; the publish is lighter, but the file is not synced and
  the exclusion hash changes.

**3b. `.llm-wiki/` (1,461 churning files).** Default is **stays in** — and that is the
point of the release: these files change while Obsidian runs, and the mvp-10 hardening
(files deleted mid-read are skipped with a reason instead of aborting the publish)
exists precisely for this folder. Excluding it would make the demo prove less.

**3c. Publication key.**

- *Option A — adopt `obsidian-vault-sync`*: the project's primary IPNS name is repointed
  from the mvp-06 demo content to your real vault. One name to remember; the demo
  content stops being what that name resolves to.
- *Option B — a fresh name* (e.g. `obsidian-vault-real`): the demo name is untouched;
  the real vault publishes under its own key.

## Step 4 — Publish the host vault from Obsidian (task 3.1)

**Why.** This is the goal-6 proof: the real vault, encrypted, from the real UI. The CLI
path was already proven in mvp-07/07b; what has never run is the **plugin** doing it on
real data at real scale, adopting the key slot the aborted 2026-09-29 run left on the
node. The adopt path (leftover `keyslots.json` + your passphrase file, no manifest) was
proven on a scratch root on 2026-10-06 — a plain first publish, no `--repair`, no flags
(task 2.3, recorded in `mvp-10-demo-run.md` §1).

**What to do.**

1. Install the gate build: copy `dist/plugin/main.js` from this repository over
   `/Users/gqadonis/obsidian/.obsidian/plugins/ipfs-sync/main.js`. The installed copy is
   currently the old 0.1.0 build (`37d1a9d5…`); the gate build is `fd46e105…` and it is
   the only build containing the churn hardening. Verify after copying:
   `shasum -a 256 /Users/gqadonis/obsidian/.obsidian/plugins/ipfs-sync/main.js` must
   print `fd46e1050230383e865a4062a7024614ee9d9542c73dc2aa690de3500590423a`.
2. Open the host vault in Obsidian, enable the plugin, and enter the settings exactly as
   the checklist in `mvp-10-demo-run.md` §3 (RPC/gateway `https://ipfs.prometheusags.ai`,
   auth None / Same as node, MFS root `/obsidian-vault-sync/real-obsidian`, the key
   decision from 3c, any exclusions from Step 1, read cap per 3a, auto-publish off).
3. Run **IPFS Sync: Publish vault**. Enter the passphrase when the unlock dialog asks
   (it is in `/Users/gqadonis/.ipfs-sync-secrets/obsidian-real.pass`).

**What to record** (section 4 of the demo record): wall time, bytes sent, file count,
root CID, the IPNS resolution result, the plugin's own publish summary, and the
**complete skipped-file list with per-file reasons** (exclusion, read cap,
changed-during-read, removed-during-read, dangling symlink). The skipped list is
first-class evidence: the published set must reconcile exactly — published + skipped =
the publishable set — or the count in Step 5 cannot be trusted. The agent then runs a
read-only `files/stat` of `/obsidian-vault-sync/real-obsidian/manifest.enc` on the node
to confirm the publish landed.

**What you should expect to see**: skipped entries for the two dangling symlinks and for
`.llm-wiki/` files that vanish or change mid-run — those skips *are* the hardening
working, not failures.

## Step 5 — Pull into a fresh vault and compare (task 3.2)

**Why.** A publish that cannot be reproduced is a backup that cannot be restored. This
is the goal-7 proof: a second Obsidian vault, starting empty, recovers the published set
**byte for byte**. The acceptance bar is **0 mismatches** across the published set —
not "looks right," but sha256 equality per file.

**What to do.**

1. Create a fresh vault in Obsidian, install the plugin (same gate build), enter the
   passphrase from the secrets file, and confirm the first-pull dialog. The pull is
   ~954 MiB, over the default 512 MB confirm threshold — the dialog asking once is
   expected behavior.
2. Run the pull. Record the counts.
3. Run the comparison (the agent prepares the commands; you execute them):
   `shasum -a 256` over both trees with the exclusion list applied, then diff the two
   lists. No new tooling, read-only.
4. Restart the CLI and run `ipfs-sync history` — it must list the publish and the pull
   from the on-disk database (this exercises the mvp-08 history store on real data).

**What to record** (section 5): published-set size, pulled count, policy-skipped count,
the comparison output, the mismatch count (must be 0), and the history listing. Files
that churned *after* the publish (`.llm-wiki/` keeps moving while Obsidian runs) are
named as **expected drift**, not mismatches — that distinction is in design.md's Risks
and is why the publish's skipped list from Step 4 matters.

## Step 6 — Optional: mobile attempt (task 3.3)

**Why.** Mobile has never been verified (risk T3). One successful pull on a phone would
retire that risk; not running it costs nothing as long as the record and the release
notes say so plainly.

**What to do.** Either run it (record device, OS, Obsidian build, procedure, outcome in
section 6) or skip it — the record and release notes will state "not run — mobile stays
unverified (T3)". Do not claim it either way without the run.

## What happens after your part

Once the record is green (sections 1–6 filled, 0 mismatches), the team finishes the
change without further questions, under the pre-approvals you recorded 2026-10-06:

1. **Docs sync (4.1, 4.2)** — DESIGN.md §4/§8 brought in line with the shipped code;
   README and CHANGELOG updated with the demo's observed numbers (the stale "v0.3.0 is
   not cut" line is fixed first).
2. **Release record (5.2)** — version bump to 0.4.0, rebuild, assets + SHA256SUMS
   assembled under `dist/release/v0.4.0/`, checksums re-verified.
3. **Outward steps (5.3, pre-approved)** — boundary commit, annotated tag `v0.4.0`,
   branch and tag pushes, and the GitHub pre-release with the four assets and the full
   notes text.
4. **Cleanup (6.1, pre-approved)** — `publish-real-20260929` (the staging tree the
   aborted September run left on the node) is removed once the round trip has passed,
   with before/after listings in the record. No other node state is touched; `key/rm`
   and `pin/rm` stay forbidden.
5. **Record assembly (6.2)** — the demo record is finalized, goals 6 and 7 are stated as
   met with it as evidence, the unverified list is carried honestly (mobile unless Step
   6 ran, Android, non-macOS hosts, the CLI's missing read cap, metadata visibility per
   T4), and the change closes — phase mvp at 16/16.

## The uncomfortable facts this demo accepts

- **Your vault's metadata becomes visible.** File count, sizes, timing and access
  patterns are not hidden by encryption — the node and the DHT see them (T4, accepted
  when the plan was approved). The release notes say this to every user.
- **The publish will show skips.** Churn skips and symlink skips in the summary are the
  system working as designed; a clean-looking publish that silently dropped files would
  be the failure, not the other way around.
- **If the comparison shows even one real mismatch, the demo fails** and the release
  does not ship on that evidence. Expected drift is named file by file; everything else
  must match byte for byte.
