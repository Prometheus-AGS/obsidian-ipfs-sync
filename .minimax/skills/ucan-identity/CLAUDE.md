# ucan-identity — developer guide

Security-critical skill. Maintenance rules:

- Every library recommendation must be re-verified against the current spec
  (ucan-wg/spec, RFC 9382) before each phase boundary — versions and
  maintenance status drift.
- SPAKE2 changes require RFC test vectors plus adversarial review; note the
  review ID in `.prometheus/decisions.md` when the component ships.
- The confidence caveat (0.562 research package) stays in SKILL.md until a
  follow-up research pass raises the evidence above threshold.
