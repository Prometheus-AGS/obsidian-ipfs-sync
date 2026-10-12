## Why

The project has a 1,085-line operator-grade README and internal docs, but no public-facing documentation site: no `site/`, no `.github/`, no Pages config (docs-site assessment, 2026-10-12). A branded Docusaurus site is the phase's deliverable, and a fully working donor pattern exists one directory away at `~/Projects/prometheus/prometheus-skill-pack/site` (Docusaurus 3.10.2, preset-classic, theme-mermaid, local search, sanitizer, Pages workflow), with the `build-branded-docusaurus` skill shipping `scaffold.mjs` / `build-site.mjs` / `verify.mjs`.

The uncomfortable part: there is no standalone KnowMe brand authority. The `--knowme-*` tokens and `knowme-conviction` logos exist only inside the donor repo, and `~/Projects/prometheus/branding/` holds Prometheus marks, not KnowMe. Reusing the donor's tokens is therefore a decision — we are adopting the donor as the de-facto brand source of truth — not a fact to assume; it is recorded in this change's design.md. Second discomfort: the repo root uses pnpm while the site will use npm with its own lockfile inside `site/`, a permanent two-package-manager split the donor accepts and we inherit; the boundary (root `package.json`/`pnpm-lock.yaml` untouched) must be enforced, not assumed. Third: this repo checkout IS a vault's `.ipfs-sync/` state path and holds `keyslots.*.json` / `state.*.json` at its root, so the sanitizer is not a formality — it is the control that keeps device state out of a public site.

## What Changes

- New `site/` directory scaffolded via the `build-branded-docusaurus` skill's `scaffold.mjs`, with dependencies aligned exactly to the donor pins: Docusaurus 3.10.2 + preset-classic + theme-mermaid 3.10.2, `@easyops-cn/docusaurus-search-local` 0.55.2, react/react-dom 18.0.0, `@mdx-js/react` 3.0.0, clsx 2.0.0, prism-react-renderer 2.3.0, yaml 2.9.0, overrides serialize-javascript 7.0.7 + uuid 11.1.1, engines node>=20. npm lockfile inside `site/` only; root stays pnpm and root `package.json`/`pnpm-lock.yaml` are NOT touched.
- Branding ported from the donor: `--knowme-*` CSS tokens from `site/src/css/custom.css`, `knowme-conviction.svg` / `knowme-conviction-dark.svg` from `site/static/img/`; title "IPFS Sync for Obsidian", tagline from README line 3; `url`/`baseUrl` from env `SITE_URL`/`BASE_URL` defaulting to `https://prometheus-ags.github.io` and `/obsidian-ipfs-sync/`; `organizationName: Prometheus-AGS`, `projectName: obsidian-ipfs-sync`; `onBrokenLinks: throw`; mermaid theme and local search configured.
- New sanitizer `site/scripts/check-public-docs.mjs` adapted from the donor's forbidden-pattern approach, extended with this repo's rules: `keyslots.*.json` / `state.*.json` contents or paths, machine-local home paths (/Users/…), bearer credentials, private key fields, `.prometheus/knowledge/wiki` paths, and the kubectl context/namespace strings used for node access. Wired as a `prebuild` script.
- Sidebar skeleton and an index landing page stub.
- `.gitignore` gains `site/node_modules/` and `site/build/`.
- No content pages beyond the stub — docs-03 owns content. No workflow — docs-04 owns deployment.

## Capabilities

### New Capabilities
- `docs-site-scaffold`: the `site/` Docusaurus skeleton with donor-pinned dependencies, KnowMe branding, the public-content sanitizer as a build gate, and package-manager separation from the pnpm root.

### Modified Capabilities
<!-- none: openspec/specs/ is empty; the delta is ADDED -->

## Impact

- New tree: `site/` (scaffold, config, CSS tokens, logos, sanitizer script, sidebar, index stub, npm lockfile).
- Root edits: `.gitignore` only (two lines). Root `package.json` and `pnpm-lock.yaml` untouched — single-writer rule respected by not writing at all.
- Dependencies: all inside `site/package.json`, pinned exactly per the donor (verified by direct reads 2026-10-12).
- Donor sources: `/Users/gqadonis/Projects/prometheus/prometheus-skill-pack/site/package.json`, `site/src/css/custom.css`, `site/static/img/knowme-conviction{,-dark}.svg`, `site/scripts/check-public-docs.mjs`; skill scripts at `~/.kimi-code/skills/build-branded-docusaurus/scripts/`.
- Downstream: docs-03 writes content into this scaffold; docs-04 deploys it.
