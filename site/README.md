# IPFS Sync documentation site

The public documentation site for IPFS Sync for Obsidian, built with
[Docusaurus](https://docusaurus.io/) and deployed to GitHub Pages. Uses npm
(the lockfile is `site/package-lock.json`); there is no yarn setup.

## Install

```bash
npm ci
```

## Local development

```bash
npm start
```

Starts a local development server and opens a browser window. Most changes are
reflected live. The `prestart` hook runs the public-content sanitizer first.

## Build

```bash
npm run build
```

Generates the static site into `build/`. The `prebuild` hook runs
`npm run sanitize`, which does two things:

1. `scripts/check-public-docs.mjs` scans everything that enters the build —
   `docs/`, `src/`, `static/` and the serialized configuration
   (`docusaurus.config.js`, `sidebars.js`, `package.json`) — for forbidden
   content: machine-local home paths, bearer/basic credentials, private-key
   fields and PEM blocks, device keyslot/state file names, and node-access
   references. Any finding fails the build.
2. `node scripts/check-public-docs.mjs --self-test` plants each forbidden
   form in a temporary site tree and asserts the scanner names them, then
   asserts a clean tree passes — so a pattern regression cannot silently
   neuter the sanitizer.

## Deployment

Push to `main`. `.github/workflows/docs-pages.yml` builds the site
(`npm ci` + `npm run build`) on every push to `main` that touches `site/`
and deploys the `build/` artifact to GitHub Pages via
`actions/deploy-pages`. There is no branch-based deploy step; do not use
`docusaurus deploy` or push a `gh-pages` branch.
