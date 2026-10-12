## Why

docs-02 delivers a branded, sanitized, building skeleton — with nothing in it. This change writes the actual documentation: home, how it works, desktop and mobile setup, CLI reference, security, limitations and troubleshooting, and the evidence page for the v0.4.0 demo. The sources are the corrected README (docs-01), DESIGN.md §8, `docs/operator/encrypted-vault.md` and `docs/operator/mvp-10-demo-record.md`, classified in the assessment as public / public-normalize / private-synthesis-only / excluded; the site restructures and normalizes rather than mirroring 1,085 README lines into an unreadable portal.

The uncomfortable part: a polished site makes everything it describes look shipped, and this project's docs describe things that are not — the agentic UI of docs/012 and `docs/design/` is designed-not-built, mobile sync has never been run, Android is untested, and the maintainer's test node is open-to-anyone and must never read as a default. The adversarial vet's addition is therefore load-bearing, not decorative: a content gate requiring every required topic to map to a published page, every behavioral claim to have a checked source, and every designed-but-unbuilt feature to be explicitly labeled — with all unchecked coverage-matrix entries resolved or explicitly disclosed before docs-04 deploys. Without that gate this site would be marketing; with it, the gaps are stated on the page where a user will actually see them, including the mobile guide that must tell users not to rely on it yet.

## What Changes

- New `site/docs/` content (docs-02's scaffold required): coverage matrix, home, "How it works", desktop setup, mobile setup, CLI reference, security, limitations & troubleshooting, evidence.
- **Content gate (acceptance, from the adversarial vet):** every required topic maps to a published page; every behavioral claim on a page has a checked source recorded in the coverage matrix; every designed-but-unbuilt feature is explicitly labeled as such; all unchecked coverage-matrix entries are resolved or explicitly disclosed before docs-04 deploys.
- The mobile setup guide carries the caveats VERBATIM: mobile sync never run, Android untested, `requestUrl` buffers whole bodies and follows redirects, no iCloud vaults.
- The evidence page describes the v0.4.0 demo exactly as recorded — agent-run CLI demo under operator decision D-E (2026-10-11), 4,825 files, 4825/4825 sha256 equal, publish 652 s, pull 343 s, root CID `bafybeihoemb6amr2txinn4w4oabcttv3wpcufxbmmsyej6xxpeu54qzzwa` — explicitly NOT an Obsidian-desktop publish; it cites `docs/operator/mvp-10-demo-record.md` and mirrors no raw scan artifacts.
- The no-default-node invariant is enforced everywhere: no page may imply a default node exists; the desktop guide states the user must enter RPC and gateway URLs.
- No code changes; no changes outside `site/` and this change folder.

## Capabilities

### New Capabilities
- `docs-site-content`: the published documentation set — topic coverage, per-page accuracy rules, the content gate over the coverage matrix, and the no-default-node invariant across all pages.

### Modified Capabilities
<!-- none: openspec/specs/ is empty; the delta is ADDED -->

## Impact

- Site: new pages under `site/docs/` (and `site/src/pages/` if the home page moves off the stub), sidebar entries completing the docs-02 skeleton.
- Sources read (not modified): `README.md` (post-docs-01), `DESIGN.md` §8, `docs/operator/encrypted-vault.md`, `docs/operator/mvp-10-demo-record.md`, `manifest.json`, `cli/` (for the CLI reference).
- Gate: sanitizer + `onBrokenLinks: throw` build + mermaid check + production build, all green; coverage matrix fully resolved or disclosed.
- Depends on: docs-02 (scaffold, sanitizer, sidebar). Downstream: docs-04 deploys this content.
