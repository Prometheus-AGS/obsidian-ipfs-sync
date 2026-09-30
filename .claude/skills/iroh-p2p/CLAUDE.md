# iroh-p2p — developer guide

Domain content lives in `SKILL.md` (transport contract) and
`references/transport-seams.md`. Maintenance rules:

- The v1/v2 split is deliberate: v1 ships, v2 is tracked. Never implement iroh
  code until a WASM/JS target exists; record re-evaluations in
  `.prometheus/decisions.md`.
- The mobile-client-only rule is structural. Any proposal violating it is
  rejected on sight — no exceptions.
