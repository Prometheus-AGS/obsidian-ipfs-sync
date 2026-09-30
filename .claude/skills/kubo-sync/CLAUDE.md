# kubo-sync — developer guide

Domain content lives in `SKILL.md` (operational contract) and
`references/mfs-delta-contract.md` (data model). This file is the maintenance
guide for the skill itself.

- Keep `SKILL.md` under 300 lines; move deep dives to `references/`.
- Every claim about the proxy or kubo behavior must trace to an observed run;
  record new observations in `.prometheus/gotchas.md` and mirror them here.
- The quirks section is load-bearing. Never soften a quirk to "usually" —
  state the observed behavior and the verification step.
- When kubo or the proxy is upgraded, re-run the quirk checklist (query-string
  args, multipart `data` field, stat-after-write) before editing this file.
