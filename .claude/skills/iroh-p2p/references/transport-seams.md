# Transport seams

The sync wire format (manifest diff + block fetches, owned by `kubo-sync`)
is the payload of both transports. Transport adapters live behind the
`HostBridge` seam (spec 005):

- `WebRtcTransport` (v1): signaling via MFS/IPNS handshake area or QR
  bootstrap; candidates trickle through the same channel; binds to the
  SPAKE2-derived session key (`ucan-identity`).
- `IrohTransport` (v2, stub only): interface defined, implementation blocked
  on a WASM/JS iroh target. Re-evaluation checklist: (1) WASM or pure-JS
  iroh build with streaming; (2) hole-punch success without TURN on the
  target platforms; (3) NodeId ↔ did:key mapping story. Record results in
  `.prometheus/decisions.md`.

Failover: direct link unavailable → kubo path continues independently;
manifests reconcile on next successful sync of either transport.
