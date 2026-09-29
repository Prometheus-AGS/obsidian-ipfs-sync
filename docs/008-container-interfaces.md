# Spec 008 — Container Interfaces: IPFS Upload, AG-UI/A2A + MCP Serving, Mobile↔Desktop Direct Links

Status: **feasibility assessment + spec — user asked "are these feasible?"; verdict: yes to all three, with one structural rule.**
Audience: the "container" = the UAR-lite WASM sandbox (guest ABI: `fs_*`,
`net_fetch`, `kv_*`, `agent_*`, `time_now`, `env_read`, `shell_exec`) running in
the plugin and in the LibreFang/bossfang Agent OS.

## The one structural rule

**Mobile can only be a client; serving happens on desktop or the daemon.**
WebViews cannot accept inbound connections (no TCP/HTTP servers on iOS/Android).
Every interface below is designed around that asymmetry. Desktop (Electron) and
the VPS sync daemon can serve everything.

## Interface 1 — IPFS file upload from the container

**Feasible on all platforms.** Implemented as a new capability-checked host
function `ipfs_add` (rather than guests hand-rolling `net_fetch` against the
kubo RPC), giving the host control over:

- pinning policy + manifest integration (spec 004/006 of DESIGN: uploads become
  part of the vault delta on next publish, or are added to `current/` directly);
- **offline queueing on mobile** — write lands in `kv_*` queue, flushes when
  connectivity returns (same queue as sync deltas);
- progress events, size limits, and per-file capability grants
  (`capabilities.ipfs: true` in the agent manifest, spec 005).

**"Could result in vector processing":** `ipfs_add` emits a host event →
embedding pipeline job (spec 006, PGlite) — async, idempotent, content-keyed
(uploading identical bytes is a no-op). Upload → available to semantic search
without any manual indexing step.

## Interface 2 — AG-UI + A2A endpoints to the container, + MCP server

**Container as client — feasible everywhere (already spec 005).** Guests reach
remote AG-UI endpoints and A2A peers through the existing `agent_*` host
bridge; lane selection and fallback chains live in the manifest.

**Container/plugin as server — feasible on desktop + daemon only:**

| Surface | AG-UI stream | A2A agent card | MCP server |
|---|---|---|---|
| Desktop Electron plugin | yes (localhost HTTP/SSE) | yes (`/.well-known/agent.json`) | yes — prior art: `obsidian-local-rest-api` serves HTTP from inside a desktop plugin |
| Node CLI sidecar (preferred) | yes | yes | yes — cleaner lifecycle than in-Electron |
| Mobile WebView | **no inbound** | **no inbound** | acts as MCP *client* (calls desktop/VPS) |
| VPS sync daemon | yes | yes | yes — the always-online front when both devices are away |

MCP design: one toolset ("vault tools": search, read, append-record (spec 007),
sync status, ipfs_add) exposed three ways — localhost MCP server (desktop/sidecar),
through UAR's existing MCP module (online, UAR-fronted), and an MCP-client
adapter in the mobile plugin that talks to whichever server is reachable. For
the Agent OS ("other tools in the container operating system"): co-located
skills connect over stdio; remote ones over HTTP — both standard MCP transports.

## Interface 3 — Mobile ↔ desktop direct link (WebRTC / iroh / other)

**Feasible. Recommended two-track approach:**

1. **v1: WebRTC DataChannel.** Proven *inside Obsidian mobile today* —
   obsidian-decentralized ships WebRTC (PeerJS) sync on iOS and Android
   WebViews, including LAN discovery via ICE/mDNS. Signaling options, best
   first: (a) the op-log/IPNS pointer as the rendezvous (devices learn each
   other's offers through sync — no extra infra), (b) self-hosted PeerServer,
   (c) manual pairing code (obsidian-decentralized's Offline Mode pattern).
   Use for: LAN delta sync bypassing the VPS, large attachment transfer,
   presence.
2. **v2: iroh (strategic, stack-aligned).** Native iroh on desktop matches the
   Prometheus fabric's pinned iroh floor; mobile would use iroh's browser path.
   **Research caveat (2026-09):** iroh-on-web is real but young — WebTransport-
   based, with open tracking issues (n0-computer/iroh #2671, #2799), and iOS
   WebView WebTransport support is the device-risk to spike early. Adopt after
   the v1 track works and the spike clears.

Alternatives considered: js-libp2p with WebRTC/WebTransport transports (viable —
Helia is already in the Phase 2 plan — but heavier than raw WebRTC for
device-to-device), raw Bluetooth (WebView access is nonexistent — out).

**Security (both tracks):** pairwise device keys established at pair time;
WebRTC/iroh transports are encrypted by construction; capabilities from the
manifest gate what each peer can request (same enforcement point as `ipfs_add`).

## Verdict summary

| # | Interface | Mobile | Desktop/Windows | Daemon |
|---|---|---|---|---|
| 1 | `ipfs_add` host fn → vector pipeline | ✅ (queued offline) | ✅ | ✅ |
| 2a | Guest → AG-UI/A2A (client) | ✅ | ✅ | ✅ |
| 2b | Serve AG-UI/A2A/MCP | ❌ inbound (client only) | ✅ (sidecar preferred) | ✅ |
| 3 | Direct device link | ✅ WebRTC v1 | ✅ WebRTC + native iroh v2 | n/a |

## Open questions

1. Signaling design for WebRTC v1: op-log rendezvous vs self-hosted PeerServer?
   (Op-log rendezvous is elegant but adds sync-latency to pairing.)
2. In-Electron server vs Node sidecar for desktop MCP/AG-UI serving — sidecar
   preferred; confirm packaging story (`npx` + auto-spawn from plugin?).
3. MCP over WebRTC DataChannel for the mobile-client case: custom transport
   worth it, or does mobile-only-via-daemon suffice?
4. iroh-web spike on real iOS hardware: WebTransport availability + throughput
   vs WebRTC DataChannel — gates the v2 track.
5. Do direct links carry A2A agent traffic too (phone-as-agent reachable from
   desktop over the DataChannel), or sync/attachments only?
