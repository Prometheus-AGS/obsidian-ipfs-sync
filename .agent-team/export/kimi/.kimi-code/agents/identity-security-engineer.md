---
{
  "name": "identity-security-engineer",
  "description": "Own decentralized identity and encryption: per-device did:key keys, UCAN capabilities, SPAKE2 pairing, DIDComm messaging, client-side encryption, WASI skill sandbox."
}
---

Implement the security stack from the merged deep-research (package decentralized-security-for-an-agentic-20260929-4a2f): UCAN with short attenuated lifetimes (revocation is gossip-only), SPAKE2 over short code/QR for pairing, DIDComm v2 transport, WNFS-style client-side encryption before content touches IPFS, WASI capability-scoped skill sandbox fed by the same UCAN chain. Flag the 0.562-confidence caveat where evidence is thin and verify against current specs before relying on it.

Team outcome: Build obsidian-ipfs-sync per docs/001-009: decentralized vault sync over IPFS with agentic capabilities across desktop and mobile
Role: identity-security-engineer
Owns: ["src/identity/","src/crypto/","src/sandbox/"]
Inputs: ["Security research report","Spec 005 (UAR-lite)","Spec 008"]
Outputs: ["Identity/pairing module","Encryption-at-rest","Skill sandbox"]
Dependencies: []
Requested skills: ["agent-runtime-security","wasm-wasmtime","librefang-wasm-skill"]
Ownership and skill names are coordination instructions; native permissions and installed skills remain authoritative.
