---
title: Roadmap
description: What is designed but not built — Phase 2 real sync, Phase 3 the AI layer, Phase 4 mobile and pinning, and the vault-agent UI.
---

# Roadmap

Everything on this page is **designed, not built**. Nothing described here
exists in a shipped build, and no date is promised. The sync that ships today
is the snapshot model in [How it works](how-it-works.md).

<!-- source: README.md L1061-1074 -->

## Phase 2 — real sync

Embed [Helia](https://github.com/ipfs/helia) and
[OrbitDB](https://orbitdb.org) in the plugin: one op-log record per file (path,
content CID, mtime, tombstones), with Merkle-CRDT merging so concurrent edits
on two devices become conflict-free. The snapshot layer in the current tree
becomes the bootstrap and restore path; the kubo client is the only seam Phase
2 replaces. Status: **designed, not built.** Until it ships, the conflict
policy is the three-way sha256 comparison with dated conflict copies described
in [How it works](how-it-works.md#pull-and-the-conflict-policy).

## Phase 3 — the AI layer

Embeddings computed on your own machine, stored as content-addressed data
pinned to the vault root, so every device gets the index that matches its
snapshot. Semantic search, RAG chat and auto-backlinks — replacing the
vault-chat plugin pattern and its plaintext API key. Status: **designed, not
built.**

## Phase 4 — mobile and always-on pinning

`ipfs-cluster` or a second node for pinning, and mobile as a real target.
Status: **designed, not built.** Mobile today is unverified end to end — see
the [mobile setup](setup-mobile.md) page, which is a tester's procedure, not a
promise.

## The vault-agent UI

<!-- source: README.md L1040-1059; docs/design/ is the design authority -->

The search and chat layer that would sit on top of sync is **designed, not
built**. The design authority is `docs/design/` in the repository (read its
README first); spec `docs/012-vault-agent-ui.md` is the pointer in the numbered
series. As designed: a vault-agent sidebar view with Search, Chat (a Notes mode
that answers only from your vault and cites each sentence, and an Agent mode
with skills, tools and approval cards) and Index tabs; a quick-ask popup; a
control center with Security first; and a lane chip on every agent surface that
says whether an answer came from this device, a remote agent, or offline. The
concept screens run in a browser with scripted data; nothing in them calls a
node or a model. Do not read any of this as a shipped feature.
