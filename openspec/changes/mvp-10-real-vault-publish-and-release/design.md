## Context

Facts verified while authoring this change (read, not assumed):

- **The hardening gap is real and narrow.** `hashFile` (`src/sync/hash.ts:28`) reads files ≤32 MB whole via `fs.read`. The CLI host maps ENOENT to `FileRemovedDuringReadError` only in the ranged path (`openForRead`, `cli/node-host-bridge.ts:73-81`); whole-file `read` is a bare `readFile` (`:122`). The plugin host has the mapping helper (`readBinaryOrRemoved`, `src/plugin/obsidian-fs.ts:116-123`) but `readAll` (`:97-102`) does not use it. The skip path already exists and already covers the subclass: `src/sync/diff.ts:89` and `src/sync/encrypted-transfer.ts:123,187` catch `FileChangedDuringReadError`, and `FileRemovedDuringReadError` extends it (`src/sync/host-errors.ts:71`). Two host edits close the gap; no engine change.
- **Scale scan (read-only, 2026-10-05, handoff).** The real vault holds nested vaults; 1.5 GB on disk; ~4,824 files / ~1.0 GB after default exclusions; one 195 MiB file (`Obsidian-wiki/.llm-wiki/file-change-queue.json`); a churning `.llm-wiki/` folder (1,461 files); 36 notes with secret-like names; 2 dangling symlinks silently skipped; the vault's `.ipfs-sync` state folder is this repository.
- **The plugin's read cap is user-configurable** (8–1024 MB, default 64: `src/plugin/read-cap.ts:6-8`, settings wiring at `src/plugin/settings-to-config.ts:157,210`), and user exclusions exist (`src/plugin/settings-tab-exclusions.ts`). The 195 MiB file is therefore a settings decision for the operator (raise the cap above it, or exclude it), recorded in the demo record — not a code change.
- **The CLI has no read cap and no exclusion option** (handoff). Out of scope here; the demo runs from Obsidian, which has both. Recorded as a limitation the docs keep.
- **Aborted-run state.** On the node: `/obsidian-vault-sync/real-obsidian/keyslots.json` only. Locally: the passphrase file `/Users/gqadonis/.ipfs-sync-secrets/obsidian-real.pass` and the vault-local slot copy `keyslots.f6720bcd22c0ded6.json` (untracked, in the vault state folder = this repository's root). `init` refuses a non-empty root (`cli/init-command.ts:66-71`), so the resume path is a publish that adopts the existing slots; publish's "node lost the manifest" refusal assumes this device published before (`src/sync/publish-refusals.ts:91-97`) and does not describe a first publish into a slots-only root. The adopt behaviour for this exact state is unverified — task 2.3 proves it on a scratch root first.
- **Releases 1 and 2 machinery exists.** `tools/release/` is descriptor-driven (`descriptors.mjs`, `record.mjs`, `steps.mjs`, `notes.mjs`); `tools/release-mvp-05.mjs` (Release 1, no checker binding; `record` bumps versions and rebuilds) and `tools/release-mvp-07.mjs` (Release 2, guard-checker bound) are the two shapes. Release 3 follows the Release 1 shape plus the demo evidence, because this change's plan names no independent review gate (decision 6). The receipt tool is `.claude/skills/delivery-cadence/scripts/publication-receipt.mjs`; Release 2 left the receipt pending for want of a first-party advertising page.
- **Branch state.** Current branch `mvp-07b-guard-removal` carries mvp-08 and mvp-09 commits; PR #1 to `main` is open; `v0.3.0` is tagged. Which ref Release 3 is cut from is the lead's integration call; the release tooling reads facts from the working tree and the batched approval shows the exact commits, so this change does not decide it.
- **README is stale on Release 2.** It says v0.3.0 "is not cut"; the handoff and the tag say it shipped 2026-10-05. The docs tasks reconcile reality first, then add v0.4.0.
- **Environment.** Node >= 24.15.0 for builds and CLI runs; on this machine `PATH=/opt/homebrew/bin:$PATH` (mvp-08/09 gate note). Shared-node shell access for read-only verification: kubectl context `know-me`, namespace `ipfs`, pod `ipfs-0`, container `ipfs` (`.prometheus/gotchas.md` 2026-10-03).

Constraints that bind: `no-console-log-in-commits`, `no-any-type`, `no-hardcoded-secrets`, `webview-safe-bundle` (the plugin host edit is WebView code), `no-python` (the secret scan and the sha256 comparison must not require Python), `no-destructive-node-ops` (the only node mutations are the operator's own publish and the confirmed removal of `publish-real-20260929`), single-writer on `package.json`/`manifest.json` (the release tool's bump is the only edit this change makes to them).

## Goals / Non-Goals

**Goals:**
- A publish of the real vault survives files vanishing or changing under it: every such file is skipped and named, never aborts the run.
- The operator publishes the host vault from Obsidian desktop, encrypted, and reproduces it into a fresh vault in Obsidian with 0 sha256 mismatches across the published set. Wall time, bytes, file count and root are recorded.
- The operator gate (secret scan, OpenAI key rotation) is satisfied before the publish, on the record.
- DESIGN.md §4/§8, README and CHANGELOG describe the code and the releases as they are.
- Release 3 (v0.4.0) meets the phase plan's release definition: version bump in both manifests, GitHub pre-release with `main.js`, `manifest.json`, the CLI tarball and SHA-256 checksums, and the demo procedure with its observed result in the record.

**Non-Goals:**
- No CLI read cap or exclusion option (the demo is from Obsidian; noted as a limitation).
- No mobile verification requirement: the mobile attempt is optional (T3). The AI-layer phone-embeddings gate (README.md) gates release-notes claims, not this release.
- No metadata hiding, padding or relay work (T4). No SPAKE2/UCAN onboarding (T5).
- No independent review gate for Release 3 (decision 6). No changes to mvp-09's suite; it is cited, not re-run.
- No removal of `publish-real-20260929` without the operator's confirmation, and no cleanup of other node state.

## Recorded decisions

**D-A. The publish reuses `/obsidian-vault-sync/real-obsidian` and adopts the existing keyslots/passphrase pair.** The passphrase already exists locally (`/Users/gqadonis/.ipfs-sync-secrets/obsidian-real.pass`) and the vault-local slot copy matches it, so reuse keeps exactly one credential to protect. Security implication, stated plainly: the leftover `keyslots.json` on the node is encrypted slot material, not plaintext; anyone holding both the passphrase file and node access could already decrypt, and reusing the pair changes that not at all — the OpenAI key rotation (unrelated credential) still happens. Alternative considered and rejected: a fresh root with a new passphrase and operator-approved removal of the leftover. It doubles passphrase management and strands slot material on the node for zero security gain. If task 2.3 proves the adopt path does not exist, the fallback is the fresh root plus the confirmed leftover removal, and this decision is amended in place.

**D-B. One batched approval for all outward steps.** The operator asked to reduce question count. The approval gate presents, in one message: the exact `git add` paths and commit message, the annotated tag `v0.4.0` and its target commit SHA, the branch and tag pushes, the `gh release create` command with the repository, the full asset list with SHA-256 checksums, and the complete release-notes text. A single yes executes all of it without further questions; the operator may strike individual items, and struck items are reported as not performed. This relaxes Release 2's per-action approvals (07b task 7.4) on operator instruction; the information shown per action is unchanged.

**D-C. Skipped files are first-class demo evidence.** The acceptance bar is 0 sha256 mismatches across the published set, and the published set is made explicit: every file not published is named with its reason (exclusion, read cap, changed-during-read, removed-during-read, dangling symlink). "0 mismatches" without the skip list would let a silently shrinking publish pass.

**D-D. The 195 MiB file and `.llm-wiki/` are operator decisions at preparation time, recorded in the demo record.** Options for the file: raise the plugin read cap above 195 MiB for the run (desktop-class memory) or add a user exclusion. `.llm-wiki/` (1,461 churning files) stays in by default — it is exactly the churn the hardening exists for — unless the operator excludes it; either way the exclusion list and its hash go into the record. The product position: the demo is more convincing with the churn included and the file's handling stated than with a sanitised vault.

## Decisions

1. **Hardening shape.** `cli/node-host-bridge.ts` `read` maps a missing file (the existing `isMissing` check used by `openForRead`) to `FileRemovedDuringReadError`; `src/plugin/obsidian-fs.ts` `readAll` routes its `readBinary` call through the existing `readBinaryOrRemoved`. No new error type, no engine change, no signature change. Tests prove the skip for both hosts: a file deleted between scan and hash produces a skipped entry and a completed publish.
2. **Preparation proves the adopt path on a scratch root.** Before the operator touches the real vault, ipfs-engineer reproduces the aborted-run state on a throwaway root under `/obsidian-vault-sync/` (slots on node, local slot copy, no manifest, no local state) and records which command continues it (expected: `publish` with `IPFS_SYNC_PASSPHRASE_FILE`; possibly `--repair`; `abandon` + fresh root if refused). The scratch root is removed after. Only the verified procedure is handed to the operator.
3. **The demo runs entirely inside Obsidian desktop** (operator decision, plan revision 2): the publish through the plugin's Publish command on the host vault, the pull through the plugin's first-pull flow into a fresh vault. The CLI appears only for read-only verification (`status`, `history`, the sha256 comparison on the operator's machine). The comparison uses `shasum -a 256` over both trees with the exclusion list applied — no new tooling, no Python.
4. **History is evidence, not a re-test.** The demo record includes `ipfs-sync history` output after a CLI restart showing the publish and the pull (mvp-08), and cites mvp-09's green `pnpm test:e2e` run as the goal-6 supporting evidence. Neither suite is extended.
5. **Docs state reality.** DESIGN.md §4 (config model as built, gateway reads, manifest v2, the CLI replacing the §4.4 scripts) and §8 (encryption as shipped; §8.6 what the node sees — the metadata that is not hidden); README reconciled to v0.3.0 shipped and extended for v0.4.0; CHANGELOG's `[0.4.0]` entry written from the demo record, after the demo.
6. **Release 3 has no independent review gate.** The phase plan names reviewers for Release 2 only and schedules the cumulative adversarial diff review at the phase boundary, after mvp-10. Recorded consequence: Release 3 ships on the strength of the standard gate, the e2e suite and the operator demo; the cumulative review follows the release, and any finding routes through the defect loop to a patch release. The hardening diff is two host files plus tests. If the lead judges this insufficient, the batched approval is delayed, not the demo.
7. **The release tool follows the Release 1 shape.** New `tools/release/release3.mjs` descriptor (version `0.4.0`, tag `v0.4.0`, `requiresFixtureStatement: false`, `record: { bumpVersions: true, build: true }`, its own notes builder with the can/cannot opening and the AI-layer gate sentence) and `tools/release-mvp-10.mjs` (plan/record), taking the demo record as evidence. It never runs git or gh; outward steps are printed text until the operator's batched approval.
8. **The notes cannot claim what was not run.** The can/cannot opening lists: no metadata hiding (count, sizes, timing visible — T4); mobile unverified unless task 3.3 ran; Android untested; the CLI's missing read cap; and the AI-layer gate — no airplane-mode or on-device-AI claim without the iPhone PGlite+ONNX memory run with peak memory recorded (this change's README.md, binding).

## Risks / Trade-offs

- [The adopt path may not exist] -> proven on a scratch root first (decision 2); fallback is D-A's recorded alternative (fresh root + confirmed leftover removal), which costs the operator a new passphrase to store.
- [Churn produces a publish that never matches the live vault at compare time] -> the comparison is against the published manifest's set, not the live tree at a later moment; files that changed after the publish are named in the record as expected drift, and the sha256 bar applies to the pulled files against their published hashes.
- [`.llm-wiki` churn makes wall time and skip counts noisy] -> recorded as observed, not tuned; the demo measures reality, not a benchmark.
- [Batched approval reduces per-action deliberation] -> accepted by the operator; mitigated by showing every exact command, checksum and the full notes text in the single gate, and by reporting struck items as not performed.
- [No independent review before Release 3] -> stated in decision 6 and in the release notes' evidence section; the cumulative phase-boundary review follows.
- [The real vault's metadata becomes node-visible] -> T4, accepted at plan time; the operator gate is where the operator accepts it for this specific vault, and the notes carry the "what is not hidden" section.
- [A secret the scan misses gets encrypted and uploaded] -> the scan is operator-run with the 36 known secret-like names adjudicated one by one; encryption bounds the exposure to holders of the passphrase, and the rotation covers the one key already known leaked. Residual risk is the operator's to accept at the gate.

## Migration Plan

Nothing to migrate. The hardening is additive error mapping. Rollback: `git revert` of the two host edits and the release tooling; the operator's published root stays valid (it is content-addressed and passphrase-held).

## Feature Operation

The release demo, operator-run (procedure; tasks 3.1–3.3 carry the steps and Verify lines):

1. Preconditions on the record: secret scan verdict with all 36 names adjudicated; OpenAI key rotated; adopt path proven on a scratch root; plugin settings recorded (node URLs, mfsRoot `/obsidian-vault-sync/real-obsidian`, key, exclusion list + hash, read cap).
2. From Obsidian desktop, the operator publishes the host vault. Record: wall time, bytes sent, file count, root CID, the IPNS resolution, and the complete skipped-file list with reasons.
3. The operator creates a fresh vault in Obsidian, installs the plugin, enters the passphrase, and pulls (first-pull confirmation shown). Record: pulled counts; the sha256 comparison of every pulled file against the source vault's published set — acceptance is 0 mismatches; policy-skipped paths named.
4. After a CLI restart, `ipfs-sync history` lists the publish and the pull from the on-disk database.
5. Optional mobile attempt: outcome recorded, or "not run — mobile stays unverified (T3)".
6. Only then: the release record, the batched outward approval, and — on the operator's separate confirmation — the removal of `publish-real-20260929`.

## Open Questions

- **Which ref Release 3 is cut from** (PR #1 merge state at release time): the lead's integration call; the batched approval shows the exact commits either way.
- **Whether the `.llm-wiki` folder and the 195 MiB file are in or out** (D-D): operator decision at task 2.3, recorded.
- **Whether the adopt path needs `--repair` or works as a plain publish**: answered by task 2.3's scratch run before the operator run is scheduled.
