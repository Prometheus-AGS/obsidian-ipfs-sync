---
name: ucan-identity
description: >
  Decentralized identity and authorization for the vault network: per-device
  did:key keys, UCAN capability chains (short-lived, attenuated), SPAKE2
  device pairing (RFC 9382), DIDComm v2 messaging, client-side
  encryption-at-rest before IPFS, and the WASI capability sandbox fed by the
  UCAN chain. Encodes the merged deep-research findings including the
  revocation caveat and library picks. Use for anything touching keys,
  tokens, pairing, encryption, or sandbox capability grants.
license: MIT
metadata:
  author: prometheus-ags
  version: '1.0.0'
  category: security
  tags: [ucan, did, spake2, didcomm, wnfs, encryption, wasi, capabilities]
user-invocable: true
---

# ucan-identity

The security stack for a serverless vault network. Every recommendation below
comes from the deep-research package
`decentralized-security-for-an-agentic-20260929-4a2f` (50 verified claims,
confidence 0.562 — partial; storage/sandbox/pairing evidence thinner than the
core UCAN/SPAKE2 findings). Where the evidence was thin this skill says so.

## Architecture (one capability vocabulary end-to-end)

```
per-device did:key keys
  → SPAKE2 pairing (short code / QR, RFC 9382)
  → attenuated UCANs (short expiry, nonce, offline validation)
  → DIDComm v2 transport (authcrypt, works over WebRTC/relays)
  → client-side-encrypted content on IPFS (WNFS-style; rs-wnfs has WASM)
  → WASI skill sandbox (capability-scoped dirs, no network by default)
  → hash-pinned MCP tools
```

Each layer consumes the previous one. A sandbox capability grant IS a UCAN
attenuation; an MCP tool listing IS a UCAN capability. No parallel authz
systems.

## Keys

- One `did:key` per device, generated on-device, never exported. Ed25519.
- Key storage per platform (decided, spec 011): desktop CLI → OS keychain via
  a Node keychain binding; desktop Obsidian → plugin data encrypted with a
  machine key where the platform allows; iOS → Keychain (Secure Enclave when
  available) via Capacitor plugin; Android → Keystore via the same plugin;
  WebView fallback → WebCrypto non-extractable CryptoKey where the platform
  supports it, with an explicit "device-trust" warning in settings UI.
- Loss of a device key = revoke its UCANs (see revocation) and re-pair.

## UCAN rules

- Default expiry **5 minutes** for invocations, **24 hours** for delegations;
  the research shows revocation cannot be timely without a server, so
  lifetimes ARE the revocation mechanism.
- Every token carries a nonce; validators enforce single-use within the
  expiry window (replay protection).
- Validation is fully offline: check signature chain, expiry (`exp`), not-before
  (`nbf`) with a ±60 s clock-skew buffer, audience, capability attenuation
  (child `att` must be a subset-refinement of parent), revocation registry.
- Never accept a token with no expiry (`WithNoExpiration` exists in some libs
  — forbid it at the validator).

## Library picks (decided, spec 011)

- **UCAN: `@ucanto/core` + `@ucanto/principal`** (Storacha's ucanto) — the most
  maintained TS implementation, powers production storage services, Ed25519
  `did:key` native. `@ixousername/ucan` (built on ucanto) adds a revocation
  registry and replay store; adopt it when we need multi-device revocation
  syncing, or lift its patterns into our own store.
- **SPAKE2: no battle-tested TS library exists.** Implement against
  `@noble/curves` (audited, dependency-free) following RFC 9382 exactly —
  the curve is edwards25519 with the spec's fixed MHF. This is a
  high-risk-of-subtle-bug component: pair it with the adversarial-review gate
  (`security-reviewer` role) and test vectors from the RFC before any
  device-pairing code ships.
- **DIDComm: `didcomm-node` / `didcomm-js`** (SICPA maintained) for the
  desktop/daemon side; evaluate its browser build for WebView use, else run
  DIDComm on the daemon only and give WebViews the WebRTC+UCAN path.

## Client-side encryption-at-rest

IPFS encrypts in transit, **not at rest** — anyone with a CID reads the file.
Therefore: encrypt file bodies with a vault content key before MFS write /
`add`; the manifest stores ciphertext CIDs and content hashes. Key
management: vault key encrypted per-device under the device key; sharing a
vault = UCAN-delegating the wrapped vault key. Follow WNFS patterns (rs-wnfs
WASM build aligns with the spec 003 Rust→WASM toolchain). Note what
encryption does NOT give you: network-level access-pattern privacy on public
IPFS (who fetched which CID, when) — that needs a private swarm/relay, which
is a separate spec decision.

## WASI skill sandbox

- Skills run in a WASI runtime (wasmtime model): guests get only pre-opened,
  capability-scoped directories; no raw syscalls, no ambient network.
- The capability set granted at spawn = the UCAN attenuation for that agent
  session. Same vocabulary, enforced twice (validator + runtime).
- Local MCP servers spawned for agents: hash-pinned tool descriptions and
  packages, no token passthrough, explicit operator approval for new local
  servers — tool poisoning and rug-pull attacks are demonstrated, not
  theoretical.

## Known hard limits (do not promise these away)

1. **Timely revocation is impossible serverlessly.** Gossip propagation only;
   past actions cannot be undone. Mitigation = short expiries.
2. **Access-pattern privacy is not solved client-side.** Private swarm or
   relay required; tracked as future work.
3. **Group access with removal** (shared vaults, kicking a device) wants
   group key agreement (Keyhive / Causal TreeKEM lineage). Out of MVP scope;
   record demand before building.

## Hard rules

- No key material in the repo, logs, or MCP tool arguments. Ever.
- No token without expiry, audience, and nonce.
- SPAKE2 code does not ship without RFC test vectors + adversarial review.
- New trusted parties (TURN, signaling, revocation registry hosts) require an
  explicit operator spec decision — flag, don't fold them in silently.
