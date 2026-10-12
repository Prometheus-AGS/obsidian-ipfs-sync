---
slug: /intro
title: Introduction
description: What IPFS Sync for Obsidian is, what is verified and what is not, and where to go next.
---

# IPFS Sync for Obsidian

Sync your vault over IPFS through a kubo node you run or trust. No Obsidian Sync
subscription, no third-party cloud. Content-addressed snapshots now; CRDT
multi-writer sync and an AI layer are designed, not built (see the
[roadmap](roadmap.md)).

<!-- source: README.md L3-9 -->

**There is no default node.** You enter the RPC URL and the gateway URL of your
own node before anything is sent. The maintainer's test node is open to anyone
and is not a default; never point a real vault at it. See
[Security](security.md).

## What ships today

<!-- source: README.md L11-55, manifest.json -->

The current release is **v0.4.0** (2026-10-11, a GitHub pre-release). It ships
an Obsidian plugin and a command-line tool that publish encrypted snapshots of
a vault to a kubo node's MFS working tree and point an IPNS key at each
snapshot:

- **Publish** encrypts every file on your device — contents, file names and the
  manifest — and sends only what changed.
- **Pull** authenticates the manifest, checks it against this device's record,
  and writes only verified files. Local edits survive as dated conflict copies.
- **Key management** (`init`, `keys change-passphrase`, `increase-cost`,
  `accept-slots`, `discard`) and history pruning (`prune-history`) are
  command-line operations; the plugin exposes the same operations as dialogs.
- A shared exclusion list keeps `.obsidian/`, `.git/`, `node_modules/` and
  similar folders out of every publish.

## What is verified, and what is not

<!-- source: README.md L19-43, L962-986 -->

Read this before you sync notes you cannot lose or cannot expose:

- The v0.4.0 evidence is an **agent-run CLI demo** of the operator's real vault
  (4,825 files, sha256-verified round trip). It was not an Obsidian-desktop
  publish. Details: [Evidence](evidence.md).
- The plugin's encryption flow, dialogs and pull **have never been run inside
  Obsidian** beyond a recorded manual operator run on desktop (2026-10-05); the
  dialogs were checked with a fake DOM, not a screen reader.
- **Mobile sync has never run.** Android is untested. The
  [mobile guide](setup-mobile.md) is a procedure, not a promise.
- No independent review of the encryption by a human or an outside party is
  recorded.
- The known limits are listed, not smoothed over, in
  [Limitations](limitations.md).

## Where to go next

- New here: [How it works](how-it-works.md), then
  [desktop setup](setup-desktop.md).
- Running the command line: the [CLI reference](cli-reference.md).
- Threat model and the open-RPC warning: [Security](security.md).
- What can go wrong and what to do:
  [Limitations and troubleshooting](limitations.md).
- What actually ran, with numbers: [Evidence](evidence.md).
- What is designed but not built: [Roadmap](roadmap.md).
- How this site is kept honest: the [coverage matrix](coverage-matrix.md).
