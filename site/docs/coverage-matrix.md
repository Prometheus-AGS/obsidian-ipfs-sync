---
title: Coverage matrix
description: The content gate's instrument — every required documentation topic, its source, its shipped-vs-designed status and the page that carries it.
---

# Coverage matrix

This page is the content gate's instrument. Every required topic has one row
with its source file, its shipped-vs-designed status, the page that carries it
and a checked flag. A row is checked only after the page text was compared
against the named source. A claim that cannot be verified from a source is
disclosed on the page, not asserted. Every content page also carries its
sources as HTML comments (`<!-- source: ... -->`) next to the claims.

| Topic | Source file | Shipped vs designed | Page | Checked |
|---|---|---|---|---|
| Install | README.md L45–55, L87–101; manifest.json (`minAppVersion` 1.12.3) | Shipped (v0.4.0 pre-release) | [Desktop setup](setup-desktop.md) | yes — 2026-10-12, compared line by line |
| Desktop setup | README.md L87–234; docs/operator/encrypted-vault.md L30–38 | Shipped; plugin flow not run in Obsidian beyond the v0.3.0 operator run (disclosed on the page) | [Desktop setup](setup-desktop.md) | yes — 2026-10-12 |
| Mobile setup | README.md L40, L309–314, L394–399, L441–442, L616–618, L978–986 | Unverified — mobile sync has never run; Android untested (page leads with this) | [Mobile setup](setup-mobile.md) | yes — 2026-10-12; four caveats verified by grep |
| Concepts / how it works | README.md L45–77, L236–247, L290–292, L738–779; DESIGN.md §8.3–§8.4, §8.10 | Shipped | [How it works](how-it-works.md) | yes — 2026-10-12 |
| Encryption and threat model | DESIGN.md §8.2–§8.6; README.md L552–578 | Shipped, not independently reviewed (disclosed) | [Security](security.md), [How it works](how-it-works.md) | yes — 2026-10-12 |
| Conflict policy | README.md L66–77, L238–247 | Shipped (CLI and plugin share the engine) | [How it works](how-it-works.md) | yes — 2026-10-12 |
| CLI reference | cli/help-text.ts; cli/args.ts; README.md L444–548 | Shipped | [CLI reference](cli-reference.md) | yes — 2026-10-12; all 41 flags and 12 commands grepped against `cli/args.ts`/`cli/help-text.ts` (spot-check output recorded in the change's tasks.md) |
| Security model | README.md L1019–1038; DESIGN.md §8.5–§8.6, §8.7 (redirects) | Shipped; the open-RPC warning is standing | [Security](security.md) | yes — 2026-10-12 |
| Limitations | README.md L928–960 ("Limits that stay"), L326–442 ("Plugin limitations") | Standing limits | [Limitations](limitations.md) | yes — 2026-10-12 |
| Troubleshooting | docs/operator/encrypted-vault.md L570–694 ("Refusals and what to do") | Operator runbook, normalized to a table with a pointer to the full runbook | [Limitations](limitations.md) | yes — 2026-10-12 |
| Evidence / demo | docs/operator/mvp-10-demo-record.md §4–§6, §9; docs/operator/mvp-10-demo-summary.json; README.md L11–43 | Agent-run CLI demo, 2026-10-11; explicitly not a desktop publish; no raw scan artifacts mirrored | [Evidence](evidence.md) | yes — 2026-10-12; every number matched to the record |
| Roadmap | README.md L1040–1074; `docs/design/` (design authority, referenced only as designed-not-built) | Designed, not built — labeled on the page | [Roadmap](roadmap.md) | yes — 2026-10-12 |

## Disclosures carried on the pages

These are the claims that could not be verified as working and are stated as
such where the reader meets them, rather than asserted:

- The plugin's encryption flow inside Obsidian (pull, restore, fork, the
  dialogs) has never been run there beyond the recorded v0.3.0 desktop
  operator run — disclosed on [Introduction](intro.md),
  [Limitations](limitations.md) and [Evidence](evidence.md).
- Mobile sync has never run; Android is untested; phone behaviour with a real
  vault and with a High-cost key slot is unmeasured — the
  [mobile setup](setup-mobile.md) page leads with this.
- Large-file pull in the plugin is not advertised as working — disclosed on
  [Limitations](limitations.md).
- The v0.4.0 demo was an agent-run CLI demo, not an Obsidian-desktop publish —
  stated on [Evidence](evidence.md).
- No independent review of the encryption by a human or an outside party is
  recorded — stated on [Introduction](intro.md), [Security](security.md) and
  [Evidence](evidence.md).
- The maintainer's test node accepts unauthenticated writes and is never a
  default — stated on [Introduction](intro.md),
  [Desktop setup](setup-desktop.md) and [Security](security.md).

No row is left unchecked or unresolved.
