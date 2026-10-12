## Context

The docs-site assessment (2026-10-12) found no `site/`, no `.github/`, no Pages config — and a complete donor pattern at `~/Projects/prometheus/prometheus-skill-pack/site`: Docusaurus 3.10.2 with preset-classic and theme-mermaid, `@easyops-cn/docusaurus-search-local` 0.55.2, React 18, multi-instance docs plugins, a `docs:check` gate, the `check-public-docs.mjs` sanitizer, and a Pages workflow with pinned action SHAs. The `build-branded-docusaurus` skill (installed at `~/.kimi-code/skills/build-branded-docusaurus/`) ships `scaffold.mjs`, `build-site.mjs` and `verify.mjs`. Brand tokens exist only inside the donor (`site/src/css/custom.css`: `--knowme-ember #e04e28`, `--knowme-ink #0b0f14`, surfaces/borders) plus the `knowme-conviction.svg` pair in the donor's `static/img/`; no standalone KnowMe brand guide exists (`~/Projects/prometheus/branding/` holds Prometheus marks, not KnowMe).

This repo's constraint surface that binds the scaffold: the repo root is pnpm (root `package.json`/`pnpm-lock.yaml` are single-writer files this change does not hold, so it must not write them at all); the repo checkout IS a vault's `.ipfs-sync/` state path with `keyslots.*.json` and `state.*.json` at its root (prior-context lesson "Avoid repo checkouts inside .ipfs-sync state directories"); the demo-record scanner caveat (gitleaks read 672 MB of 955 MiB) is context for sanitizer strictness.

## Recorded decision: the donor is the brand and dependency source of truth

**Decision (recorded 2026-10-12):** the site reuses the prometheus-skill-pack donor verbatim where possible — exact dependency pins, `--knowme-*` CSS tokens, `knowme-conviction` logos, sanitizer approach, and (in docs-04) the Pages workflow shape — rather than scaffolding fresh and re-deciding each choice.

**Rationale:** the donor is the operator's own production site, so its pins are already vetted in the exact deployment environment (GitHub Pages, `*.github.io`) this site targets; the pins were verified by direct reads on disk 2026-10-12, satisfying the verify-against-official-sources rule without re-opening settled dependency decisions. KnowMe has no standalone brand authority file, so the donor's tokens are the de-facto brand; adopting them explicitly is more honest than restyling from memory. **Alternative considered and rejected:** `create-docusaurus` fresh + independently chosen versions — re-opens every decision the donor settled and forfeits the verified pins, for zero reader benefit. **Stated risk:** the donor becomes a hidden upstream; when the donor's pins move, this site does not follow automatically. Accepted: pins are exact, so drift is visible at the next deliberate alignment, never silent.

## Decisions

1. **Location and package-manager separation.** Everything lives under `site/` with npm and its own `package-lock.json`. The repo root stays pnpm; root `package.json` and `pnpm-lock.yaml` are not touched (this change is not their writer). `.gitignore` gains `site/node_modules/` and `site/build/` at the gate task, after the build proves what the output paths are.
2. **Dependency pins.** Copied exactly from the donor's `site/package.json` (read 2026-10-12): Docusaurus 3.10.2 + preset-classic + theme-mermaid 3.10.2, `@easyops-cn/docusaurus-search-local` 0.55.2, react/react-dom 18.0.0, `@mdx-js/react` 3.0.0, clsx 2.0.0, prism-react-renderer 2.3.0, yaml 2.9.0, overrides serialize-javascript 7.0.7 + uuid 11.1.1, engines node>=20. Exact versions, no ranges, per the dependency-pin rule; the donor read is the recorded rationale.
3. **Identity and env pattern.** Title "IPFS Sync for Obsidian"; tagline from README line 3. `url` and `baseUrl` come from `SITE_URL`/`BASE_URL` env vars defaulting to `https://prometheus-ags.github.io` and `/obsidian-ipfs-sync/` — the same env pattern the donor uses, so local previews and the Pages deploy share one config. `organizationName: Prometheus-AGS`, `projectName: obsidian-ipfs-sync`, `onBrokenLinks: throw` (a broken link fails the build; docs-03 relies on this as its link check).
4. **Sanitizer.** Adapt the donor's `check-public-docs.mjs` forbidden-pattern scanner; add this repo's rules: `keyslots.*.json` / `state.*.json` contents or paths, machine-local home paths (/Users/…), bearer credentials, private key fields, `.prometheus/knowledge/wiki` paths, and the kubectl context/namespace strings used for node access. Wired as `prebuild` so no build — local or CI — can emit a site that carries them. The sanitizer scans what will be published, never the repo root's state files themselves.
5. **Structure.** Sidebar skeleton names the docs-03 sections without creating their pages (the `onBrokenLinks: throw` build is the check that no entry dangles). The index page is a stub; docs-03 owns real content.
6. **Gate.** `verify.mjs` from the skill + `npm ci && npm run build` in `site/` + sanitizer green, at the final task only — one integration boundary, per the phase-gate rule.

## Risks / Trade-offs

- [Two package managers in one repo] -> accepted and bounded: npm is confined to `site/`, the gitignore lines keep its artifacts out of git, and task 2.1's verify proves the root manifests are untouched.
- [Donor as hidden upstream] -> accepted (recorded decision above): exact pins make drift visible and deliberate, never silent.
- [Sanitizer false positives on legitimate docs, e.g. a home path in an example] -> the fix is to write the example with a placeholder (`<vault>`, `$HOME`), which is better documentation anyway; no exception mechanism is added.
- [Scaffold output drift from the skill's current templates] -> `verify.mjs` is the skill's own conformance check; if scaffold and verifier disagree, that is a skill bug surfaced at the gate, not something to patch around silently.

## Migration Plan

Nothing exists to migrate — there is no prior site. Rollback: `git revert` removes `site/` and the two `.gitignore` lines; nothing else in the repo references the site.

## Open Questions

- **Whether `SITE_URL`/`BASE_URL` need a staging variant** for fork previews: deferred; the env pattern already permits it without config changes.
- **Multi-instance docs plugins** (the donor has them): not adopted in the skeleton; docs-03 adds instances only if the content shape demands it.
