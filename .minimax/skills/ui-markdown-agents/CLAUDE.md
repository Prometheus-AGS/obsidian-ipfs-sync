# ui-markdown-agents — developer guide

Rendering contract skill. Maintenance rules:

- The chunk table is normative: adding a new AG-UI chunk type means adding a
  row here and a BDD scenario in `features/`.
- Sanitization profiles (DOMPurify svg/default) are part of the contract —
  changing them is a security-relevant change, route through security-reviewer.
- Platform constraints (touch targets, lazy-loading, long-press) are checked
  in review, not assumed.
