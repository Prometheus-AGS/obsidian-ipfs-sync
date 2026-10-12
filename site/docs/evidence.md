---
title: Evidence
description: What actually ran — the v0.4.0 real-vault demo exactly as recorded, and the earlier releases stated honestly.
---

# Evidence

This page states what was demonstrated, by what route, and what it does not
prove. The full record is `docs/operator/mvp-10-demo-record.md` in the
repository (with the machine-readable summary `mvp-10-demo-summary.json`
beside it); this page mirrors its conclusions, not its raw scan artifacts.

## The v0.4.0 real-vault demo (2026-10-11)

<!-- source: docs/operator/mvp-10-demo-record.md §4-§5; docs/operator/mvp-10-demo-summary.json -->

**What it was:** an **agent-run CLI demo** under operator decision **D-E**
(operator authorization 2026-10-11). The CLI gate build published the
operator's real vault to the operator's own kubo node and pulled it back into a
fresh, empty directory. It ran through the command line, **not the Obsidian
plugin** — no Obsidian-desktop publish of the real vault has happened. The
mobile attempt was **not run**; mobile stays unverified (T3).

**Publish:**

- 4,825 files written, 0 removed — the publishable set exactly, 0 skipped
  files;
- plaintext publishable set 1,001,531,092 bytes (about 954.9 MiB), including a
  195.4 MiB file that published uncapped (the CLI has no read cap);
- wall time **652 s**; sequence 1;
- publication key `obsidian-vault-real`, created by the publish;
- root CID
  `bafybeihoemb6amr2txinn4w4oabcttv3wpcufxbmmsyej6xxpeu54qzzwa`, with the IPNS
  name resolving to it.

**Pull:**

- 343 s; 4,825 fetched, 0 unchanged, 0 conflicts, 0 integrity-failed,
  0 unfetched, 0 skipped, 0 remote-deleted;
- root CID equal to the publish's IPNS value, sequence 1.

**Integrity check:** a sha256 comparison of every pulled file against the
source vault's published set gave **4,825 equal, 0 mismatches, 0 missing,
0 extra**.

**One ergonomics note, as recorded:** the first pull attempt stopped at the
CLI's 512 MiB confirmation ceiling with exit 1 and fetched nothing; the
successful run passed `--accept-large`.

## What the demo does not show

<!-- source: docs/operator/mvp-10-demo-record.md §6, §9; docs/operator/mvp-10-demo-summary.json unverified -->

- It is not an Obsidian-desktop publish or pull. The plugin flow of the current
  build has not run inside Obsidian.
- Mobile is unverified (the attempt was not run); Android is untested;
  non-macOS hosts are untested.
- The node's RPC endpoint took no credential for this run; an authenticated
  endpoint with the plugin is unverified.
- Metadata visibility is accepted, not hidden: the node saw 4,825 encrypted
  blobs whose sizes map one to one onto the source files, plus the timing of
  the publish and the pull. See [Security](security.md).
- Before the publish, the operator ran a secret scan over the publishable set
  and revoked the live credentials it surfaced; the publish then went ahead
  encrypted under decision D-E. The scan artifacts were redacted, lived outside
  the repository, and were deleted after adjudication — this page deliberately
  carries none of them.

## Earlier releases, stated honestly

<!-- source: README.md L11-43, L946-961 -->

- **v0.2.0** (a GitHub pre-release) is the **plaintext** build: no encryption;
  everything it published is readable by anyone who obtains the CID. The
  current tree refuses to read what 0.2.0 published. Treat everything it
  published as public.
- **v0.3.0** (2026-10-05) is the first **encrypted** release — and the release
  whose line removed the fixture-only guard: the removal shipped on branch
  `mvp-07b-guard-removal` (commit `38db5f8`), the branch v0.3.0 shipped from;
  `main` kept the old guard until PR #2 merged that branch on 2026-10-12. Its
  evidence holds a review record (unsigned, bound to the tree by git
  history), a recorded manual operator run in Obsidian desktop against the
  maintainer's shared node, and a measured phone key-derivation timing
  (0.57 s on iOS 27.2). These are attestations, not proofs, and no review by
  a human or an outside party is recorded. An encrypted publish or pull has
  not run on a phone.
- **v0.4.0** (2026-10-11, a GitHub pre-release) keeps the guard removed and
  adds the mid-read churn hardening (a file deleted between the scan and its
  read raises `FileRemovedDuringReadError` and is skipped with the removal
  reason instead of aborting the publish), the device-local `history`
  command, and is the tree the demo above ran on. Its release is gated by a
  checker that binds the shipped bytes to a tree hash and a reproducible
  clean-export build and requires the review, operator-run and phone-timing
  records — attestations that make forgery more work and leave a trail, not
  proofs.

A version number says nothing about safety beyond what those attestations
cover. The standing limits are on the [limitations](limitations.md) page.
