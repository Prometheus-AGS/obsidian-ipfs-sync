# ASSESSMENT: docs-site

Project: IPFS Sync for Obsidian
Date: 2026-10-12
Codebase baseline: v0.4.0 pre-release shipped 2026-10-11 from the mvp phase (16/16 changes terminal, reflection written); PR #2 merged to main; the tree holds a 1,085-line operator-grade README, `docs/` (12 numbered internal specs + `design/` + `operator/`), and no public-facing documentation site.
Cross-tool progress: none — phase created this session, progress 0/0.

## Recalled lessons (from prior-context.md)

- **Lesson (project, 2026-10-04, no-default-node fix):** the docs pass after that fix enumerated every line stating or implying a default node (`README.md`, `DESIGN.md`, runbook, `docs/005`, two design mocks, constraints, gotchas). Shapes this assessment: the new site must inherit that invariant — no page may imply a default node exists; the maintainer's test node is documented as open-to-anyone and not a default.
- **Lesson (pk, mvp reflection):** the mvp-10 demo was agent-run under operator decision D-E (2026-10-11), CLI-only, not the Obsidian plugin. Shapes this assessment: any "demo" or "evidence" page on the site must describe the round trip exactly as recorded (CLI, agent-run, D-E) and must not imply an Obsidian-desktop publish of the real vault happened.

## Knowledge gaps (carried from prior-context.md)

- Cadence iteration 9 open in `.prometheus/cadence` (missing receipts; adapter subprocess broken; no documented fallback). — not docs-site scope; `/learn-goal` offer: none, this is recovery work.
- Publication receipt pending for v0.2.0, v0.3.0, v0.4.0 — the first-party-page condition has never been satisfiable. **Relevant:** a deployed docs site on a first-party domain could satisfy the receipt condition; flagged for plan.
- CLI has no read cap and no exclusion option (plugin-only); stated in the v0.4.0 notes, unscheduled. — must be documented as-is on the site, not fixed here.
- Mobile sync unverified (T3); Android untested; non-macOS hosts untested; authenticated endpoint untested. — the mobile setup guide must carry these caveats verbatim.
- OpenSpec `verify`/`archive` never run; 11 completed-but-unarchived changes; `openspec/specs/` empty. — not docs-site scope.
- Old demo roots remain on the node; only `publish-real-20260929` was in cleanup scope. — not docs-site scope.
- `keyslots.f6720bcd22c0ded6.json` untracked at repo root; ignore/keep decision pending. — the sanitizer must treat `keyslots.*.json` and `state.*.json` as excluded from site content.
- Demo-record scanner caveat: gitleaks read 672 MB of 955 MiB. — context for the sanitizer rules.

## IMPLEMENTATION STATUS

- Docusaurus site: **MISSING** — no `site/`, no `.github/`, no Pages config. Donor pattern fully available: `~/Projects/prometheus/prometheus-skill-pack/site` (Docusaurus 3.10.2, preset-classic, theme-mermaid, `@easyops-cn/docusaurus-search-local` 0.55.2, React 18, multi-instance docs plugins, `docs:check` gate, sanitizer `check-public-docs.mjs`, Pages workflow with pinned action SHAs). The `build-branded-docusaurus` skill ships `scripts/scaffold.mjs`, `scripts/build-site.mjs`, `scripts/verify.mjs`.
- KnowMe branding: **PARTIAL** — brand tokens exist only inside the donor repo (`site/src/css/custom.css`: `--knowme-ember #e04e28`, `--knowme-ink #0b0f14`, surfaces/borders) plus logos `knowme-conviction.svg` / `knowme-conviction-dark.svg` in the donor's `static/img/`. No standalone KnowMe brand guide was found; `~/Projects/prometheus/branding/` holds Prometheus marks, not KnowMe.
- Desktop setup guide: **MISSING** as user-facing doc. Raw material: README "Obsidian plugin" + "CLI usage" sections (accurate, operator-grade, too deep for a quickstart), `docs/operator/encrypted-vault.md` runbook.
- Mobile setup guide: **MISSING**. Raw material: README "Phones" notes (BRAT from a pre-release with its own tag; no iCloud vaults; Android untested; mobile sync never run). The guide must carry the unverified-mobile caveats, not imply support.
- GitHub Pages deployment: **MISSING** — repo has no `.github/` at all. Donor workflow `docs-pages.yml` is deployment-only (allowed under the skill-pack's local-only rule; this repo's AGENTS.md does not forbid it). Pages must be enabled in repo settings before the first deploy.
- Repository About link: **MISSING, with a hard constraint** — no automation for it exists anywhere in the donor. `GITHUB_TOKEN` cannot edit repository metadata (the "Update a repository" endpoint needs Administration write). Options for plan: (a) one-time operator-authorized `gh repo edit --homepage <pages-url>` — simplest, recommended; (b) a PAT-secret-backed workflow step — ongoing secret maintenance for a set-once value.
- README correctness: **PARTIAL** — sampled claims verified accurate (manifest `version: 0.4.0`, `minAppVersion 1.12.3`; `styles.css` does not exist as stated; command inventory matches `cli/`). Stale items found: L11 "Release 3 (v0.4.0) is being cut from this tree" (shipped 2026-10-11); L18 "`main` keeps the old guard until the release merge" and L907 "`main` until the release merge" (PR #2 merged 2026-10-12); L960 "bound to the tree of branch `mvp-07b-guard-removal` … not to `main`" (superseded by the merge).

## Content classification (per build-branded-docusaurus)

- **public:** `README.md` (normalized), `DESIGN.md` §8 threat model (normalized), `manifest.json` facts, demo summary numbers.
- **public-normalize:** `docs/operator/encrypted-vault.md` (runbook tone → user guide), README CLI reference.
- **private-synthesis-only:** `docs/operator/mvp-10-demo-*.md/json` (public in the repo, but raw operator workflow evidence — the site cites the record, never mirrors it), `docs/001`–`012` (internal specs; `012`/`design/` describe an unbuilt agentic UI — reference only as "designed, not built").
- **excluded:** `docs/design/*.html` (scripted-data mocks), `.kbd-orchestrator/`, `.prometheus/`, `keyslots.*.json`, `state.*.json`, `tools/`, `dist/`, anything matching the donor sanitizer's rules (home paths, bearer tokens, private keys, raw wiki paths).

## CROSS-TOOL PROGRESS

- NONE — no cross-tool activity recorded for this phase.

## SPEC GAP SUMMARY

- `openspec/specs/` is empty (verify/archive never run — recorded debt), so there is no canonical spec to assess against; the phase goals in `goals.md` are the target.
- No spec exists yet for the docs site itself — plan stage must produce one (OpenSpec change) covering: site structure, content inventory, branding source of truth, deployment, About-link mechanism, README corrections.

## BUILD HEALTH

- build check: **UNKNOWN** for the current tree — not re-run this session (docs/phase-boundary commits only since the mvp closeout gate, which passed; evidence in `mvp/reflection.md`). A full gate runs at the implementation boundary, not during assessment.
- known violations: NONE observed.
- test coverage: N/A for docs scope; the site's own gate will be `verify.mjs` + production build + link check.

## CONSTRAINT CHECK

- AGENTS.md violations: NONE. Note for plan: docs work routes to `documentation-specialist` per the team rule; reviewers stay dormant until the final gate.
- constraints.md violations: NONE. Watch-item for implementation: the repo root uses pnpm; the donor site/ uses npm with its own lockfile — keep the two package managers separated exactly as the donor does, and add `site/node_modules` to `.gitignore` handling.

## GOAL PROGRESS

- Branded Docusaurus site explaining the plugin: **NOT MET** — nothing exists.
- Setup guides for desktop and mobile: **NOT MET** — raw material only.
- GitHub Pages via Actions + About link: **NOT MET** — no workflow; About-link mechanism undecided (constraint above).
- README.md 100% correct: **NOT MET** — four stale statements identified (listed above).

## Sycophancy review (self-check; MCP detector unavailable in this session — no sycophancy-correction tools are loaded, so this is a manual pass)

- S-03 risks surfaced: (1) mirroring the 1,085-line README into a site would produce an unreadable portal — the value is in restructuring, not copying; (2) the demo evidence is real but operator-workflow-flavored — raw mirroring would over-expose process detail for no reader benefit; (3) the About-link ask as literally stated ("the github action sets up a link") is not achievable with `GITHUB_TOKEN`; the plan must present the trade-off rather than silently substituting; (4) KnowMe branding has no standalone authority file — reusing donor tokens is a decision to record, not a fact to assume.
- No "clearly/obviously" claims; every status above cites a file or an observed absence.

ASSESSMENT COMPLETE
