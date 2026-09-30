---
name: iroh-p2p
description: >
  Direct device-to-device sync links for the vault: WebRTC data channels (v1,
  shipping) and the iroh upgrade path (v2, designed not built). Covers pairing
  flow integration, signaling options, NAT traversal reality, and the
  mobile-client-only structural rule. Use when building spec 008 direct links,
  debugging connection failures, or planning the iroh migration.
license: MIT
metadata:
  author: prometheus-ags
  version: '1.0.0'
  category: development
  tags: [p2p, webrtc, iroh, libp2p, nat-traversal, mobile-sync]
user-invocable: true
---

# iroh-p2p

Two generations of the same feature — direct sync between your devices
without round-tripping the kubo node. v1 ships on WebRTC; v2 moves to iroh
when its WASM/WebView story matures. This skill holds both so the v1 design
does not paint itself into a corner.

## The structural rule (spec 008)

**Mobile is client-only.** iOS/Android WebViews cannot accept inbound
connections — no listening sockets. Every design below assumes: desktop or
the VPS daemon serves; phones connect out. If a proposal requires a phone to
listen, it is wrong for this project.

## v1 — WebRTC data channels (shipping)

- Transport: WebRTC `RTCDataChannel` (reliable, ordered) over the platform's
  ICE stack. Obsidian desktop provides Chromium; mobile WebViews provide
  platform WebRTC (Safari WKWebView / Android WebView both expose it).
- **Signaling has no server.** The two devices exchange SDP/ICE candidates
  through a channel they already share: the kubo node itself (a small
  `handshake/` MFS area or an IPNS-published offer record), QR-code manual
  copy for the first pair, or the paired-session channel afterward. Manual
  QR fallback must always work — it is the pairing bootstrap (see
  `ucan-identity` for the SPAKE2 layer that authenticates it).
- Flow: offerer publishes offer → resolver polls → candidates trickle through
  the same channel → `datachannel` opens → vault delta sync runs as a
  bidirectional stream of manifest diffs + file blocks → close.
- NAT reality: without a TURN server, ~10-20% of pairs (symmetric NAT on both
  ends) cannot connect. Documented limitation, not a bug; the kubo path is
  the fallback. A public TURN server is a later option but reintroduces a
  trusted third party — flag it as a spec decision, never silently.
- Payload: reuse the delta-sync wire format from `kubo-sync`
  (manifest diff + `cat`-fetchable blocks). Do not invent a second format.

## Pairing integration

Device pairing is owned by `ucan-identity` (SPAKE2 over short code / QR).
This skill owns what happens after: the WebRTC transport binds to the
session key derived during pairing, so the encrypted data channel and the
identity proof are the same secret. Do not add a second key exchange here.

## v2 — iroh (designed, not built)

Track, don't implement. The upgrade reasons and blockers:

- **Why iroh eventually:** connection-oriented QUIC with hole punching that
  works far more often than ICE without TURN; first-class NAT traversal via
  relays you can self-host; docs protocol gives you sync-able structures
  rather than raw blocks; one identity story (NodeIds) that maps cleanly onto
  our per-device DIDs.
- **Why not now:** the shipping surfaces for iroh are Rust, Swift, Kotlin,
  Python, and Node (NAPI). Browser/WASM support is partial and moving; an
  Obsidian mobile WebView cannot run a Node NAPI module. Until iroh ships a
  WASM or pure-JS target with data-channel-equivalent streaming, v1 stays
  WebRTC. Re-evaluate at each phase boundary; record the re-check in
  `.prometheus/decisions.md`.
- **Design constraint for v1 that v2 keeps:** the sync wire format and the
  pairing flow are transport-independent. Swapping WebRTC for iroh must be a
  transport adapter change, not a protocol rewrite. Enforce this by keeping
  transport code behind the `HostBridge` seam (spec 005).

## Failure handling

- Connection drops mid-sync: resume from manifest diff — both sides version
  manifests, so reconnection diffs from the last common version.
- Candidate timeout: after 15 s of no connectivity, fail over to kubo sync
  and surface "direct link unavailable" in the UI (spec 009 rendering rules).
- Never block the kubo publish/pull path on direct-link availability; the
  two run independently and reconcile via manifests.

## Hard rules

- No inbound listeners on mobile, ever (structural rule above).
- One wire format (`kubo-sync` delta format) across both transports.
- Pairing crypto is `ucan-identity`'s; this skill consumes the derived
  session key, it does not create keys.
- No third-party signaling or TURN servers without an explicit spec decision —
  decentralized means no new trusted parties by default.
