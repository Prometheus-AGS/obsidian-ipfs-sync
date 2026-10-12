## Purpose

Defines the `site/` Docusaurus skeleton: donor-pinned dependencies, KnowMe branding, site identity with env-driven URL config, a public-content sanitizer wired as a build gate, and strict package-manager separation from the pnpm repo root.

## ADDED Requirements

### Requirement: Package-manager separation
The site SHALL live under `site/` with npm and its own `package-lock.json`. The repo root SHALL remain pnpm, and the root `package.json` and `pnpm-lock.yaml` SHALL NOT be modified by this capability. `site/node_modules/` and `site/build/` SHALL be gitignored.

#### Scenario: Root manifests untouched
- **WHEN** `git status --porcelain package.json pnpm-lock.yaml` runs after the scaffold tasks
- **THEN** it prints nothing

### Requirement: Dependencies pinned to the donor exactly
`site/package.json` dependencies, devDependencies, overrides and engines SHALL match the donor (`prometheus-skill-pack/site/package.json`, read 2026-10-12) exactly: Docusaurus 3.10.2 + preset-classic + theme-mermaid 3.10.2, `@easyops-cn/docusaurus-search-local` 0.55.2, react/react-dom 18.0.0, `@mdx-js/react` 3.0.0, clsx 2.0.0, prism-react-renderer 2.3.0, yaml 2.9.0, overrides serialize-javascript 7.0.7 + uuid 11.1.1, engines node>=20. Versions SHALL be exact, not ranges.

#### Scenario: Pin conformance
- **WHEN** the site's manifest is compared to the donor's dependency sections
- **THEN** no version differs except documented, intentional divergences (name, scripts)

### Requirement: KnowMe branding and site identity
The site SHALL carry the donor's `--knowme-*` CSS tokens and `knowme-conviction.svg` / `knowme-conviction-dark.svg` logos. Title SHALL be "IPFS Sync for Obsidian", tagline SHALL come from README line 3, `url`/`baseUrl` SHALL read from `SITE_URL`/`BASE_URL` env vars defaulting to `https://prometheus-ags.github.io` and `/obsidian-ipfs-sync/`, and `organizationName`/`projectName` SHALL be `Prometheus-AGS`/`obsidian-ipfs-sync`. `onBrokenLinks` SHALL be `throw`; mermaid theme and local search SHALL be configured.

#### Scenario: Broken link fails the build
- **WHEN** a page links to a document that does not exist
- **THEN** `npm run build` fails

### Requirement: Public-content sanitizer as a build gate
A sanitizer adapted from the donor's forbidden-pattern scanner SHALL run as a `prebuild` script. In addition to the donor's patterns it SHALL forbid: `keyslots.*.json` / `state.*.json` contents or paths, machine-local home paths (/Users/…), bearer credentials, private key fields, `.prometheus/knowledge/wiki` paths, and the kubectl context/namespace strings used for node access.

#### Scenario: Forbidden content blocks the build
- **WHEN** publishable content contains a `keyslots.` path, a `/Users/` home path or a bearer-token shape
- **THEN** the sanitizer exits nonzero, names the matched patterns, and the build does not run

### Requirement: Scaffold passes the skill verifier and a clean production build
The scaffold SHALL pass the `build-branded-docusaurus` skill's `verify.mjs`, and `npm ci && npm run build` inside `site/` SHALL succeed from a clean install with the sanitizer green.

#### Scenario: Clean-room build
- **WHEN** `npm ci && npm run build` runs in `site/` with no prior `node_modules`
- **THEN** the build succeeds and emits `site/build/`
